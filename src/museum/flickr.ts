/**
 * Flickr Commons — institutional photostream source (Library of Congress,
 * British Library, and any other Commons account).
 * ---------------------------------------------------------------------------
 * Docs: https://www.flickr.com/services/api/  (flickr.people.getPhotos)
 *
 * Why Flickr instead of the institutions' own APIs:
 *   - loc.gov serves Cloudflare JS challenges to every non-browser client, so
 *     its JSON API is unusable server-side (verified 2026-07).
 *   - The British Library's data services are still offline after the 2023
 *     cyber-attack.
 * Both institutions publish large public-domain collections on Flickr Commons
 * under "no known copyright restrictions", and the Flickr API is stable and
 * script-friendly — one source covers both (and any account added later).
 *
 * Requires a (free) API key in `FLICKR_API_KEY`. Only photos whose license is
 * "no known copyright restrictions" (7), CC0 (9), or PD-marked (10) are kept,
 * so re-hosting the image files to S3 follows the same practice as Wikimedia
 * Commons / Openverse. Accounts are configurable via `FLICKR_ACCOUNTS`.
 *
 * Rate limit: 3600 requests/hour/key — a run uses a handful of calls, far
 * below it; pages are still fetched sequentially with a pause.
 */
import type { Artwork, Artist } from "../types/domain.js";
import type { CatalogData, MuseumSource } from "./source.js";
import { inferCategory, inferEmpire } from "./taxonomy.js";
import { fetchJsonRetry } from "../utils/http.js";
import {
  stripHtml,
  slugify,
  initialsOf,
  seededInt,
  uniqueTags,
  hslToHex,
  hashString,
} from "../utils/text.js";

// ── Upstream API shapes (only the fields we request) ────────────────────────

interface FlickrPhoto {
  id: string;
  title?: string;
  license?: string;
  description?: { _content?: string };
  ownername?: string;
  tags?: string;
  /** Size-suffixed URLs from `extras` — availability varies per photo. */
  url_c?: string; // ~800px
  url_l?: string; // ~1024px
  url_m?: string; // ~500px
  url_o?: string; // original
}

interface FlickrPhotosPage {
  stat?: string;
  code?: number;
  message?: string;
  photos?: {
    page?: number;
    pages?: number;
    total?: number | string;
    photo?: FlickrPhoto[];
  };
}

/** Licenses safe to re-host: 7 = no known copyright restrictions (Commons),
 *  9 = CC0, 10 = US Government work / PD mark. */
const OK_LICENSES = new Set(["7", "9", "10"]);

/**
 * Default Commons accounts, with a medium hint that steers the browse
 * category (the photos themselves rarely say what they are).
 */
export const DEFAULT_FLICKR_ACCOUNTS: readonly FlickrAccount[] = [
  { nsid: "8623220@N02", mediumHint: "Photograph" }, // The Library of Congress
  { nsid: "12403504@N02", mediumHint: "Book illustration" }, // The British Library
];

export interface FlickrAccount {
  nsid: string;
  mediumHint?: string;
}

const PAGE_SIZE = 100;
/** Pages fetched per account per run at most. */
const MAX_PAGES_PER_ACCOUNT = 5;
/** Pause between page requests. */
const PAGE_PAUSE_MS = 250;
const DEFAULT_ACCENT = "#22242b";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FlickrSource implements MuseumSource {
  /**
   * Page each account's NEXT run should start from (keyed by NSID), so daily
   * runs walk fresh slices of each photostream. Read by the ingest job.
   */
  nextPages: Record<string, number> = {};

  constructor(
    private readonly apiBaseUrl: string,
    private readonly apiKey: string,
    private readonly accounts: readonly FlickrAccount[],
    private readonly limit: number,
    /** Per-account start pages (1-based), from the persisted ingest state. */
    startPages: Record<string, number> = {},
  ) {
    for (const account of accounts) {
      this.nextPages[account.nsid] = Math.max(1, Number(startPages[account.nsid]) || 1);
    }
  }

  async fetchCatalog(): Promise<CatalogData> {
    if (!this.apiKey) {
      throw new Error(
        "FlickrSource needs FLICKR_API_KEY — get a free key at " +
          "https://www.flickr.com/services/api/keys/ and set it in .env",
      );
    }

    const artworks: Artwork[] = [];
    const artistAcc = new Map<string, { id: string; name: string; works: number }>();
    const perAccount = Math.max(1, Math.ceil(this.limit / this.accounts.length));

    for (const account of this.accounts) {
      const photos = await this.collectPhotos(account, perAccount);
      for (const photo of photos) {
        if (artworks.length >= this.limit) break;
        const { artwork, artistId, artistName } = this.mapPhoto(photo, account);
        artworks.push(artwork);
        const acc = artistAcc.get(artistId) ?? { id: artistId, name: artistName, works: 0 };
        acc.works++;
        artistAcc.set(artistId, acc);
      }
    }

    if (artworks.length < this.limit) {
      console.warn(
        `  (Flickr: kept ${artworks.length}/${this.limit} photos — the ` +
          `accounts may be license- or size-sparse on this slice.)`,
      );
    }

    const artists = Array.from(artistAcc.values()).map((acc) => this.buildArtist(acc));
    return { artworks, artists };
  }

  // ── Ingestion ─────────────────────────────────────────────────────────────

  /** Page through one account's photostream, keeping re-hostable photos. */
  private async collectPhotos(
    account: FlickrAccount,
    limit: number,
  ): Promise<FlickrPhoto[]> {
    const kept: FlickrPhoto[] = [];
    const seenTitle = new Set<string>();
    let page = this.nextPages[account.nsid] ?? 1;
    let totalPages = Number.POSITIVE_INFINITY;

    for (let read = 0; read < MAX_PAGES_PER_ACCOUNT && kept.length < limit; read++) {
      const url =
        `${this.apiBaseUrl}/?method=flickr.people.getPhotos` +
        `&api_key=${encodeURIComponent(this.apiKey)}` +
        `&user_id=${encodeURIComponent(account.nsid)}` +
        `&extras=${encodeURIComponent("description,license,tags,owner_name,url_c,url_l,url_m,url_o")}` +
        `&per_page=${PAGE_SIZE}&page=${page}` +
        `&format=json&nojsoncallback=1`;

      const res = await fetchJsonRetry<FlickrPhotosPage>(url);
      if (res.stat !== "ok") {
        // A bad key / bad account is a config problem — fail loudly, never
        // half-ingest. (Message example: "Invalid API Key".)
        throw new Error(
          `Flickr API error for ${account.nsid}: ${res.message ?? "unknown"} ` +
            `(code ${res.code ?? "?"})`,
        );
      }
      if (res.photos?.pages) totalPages = res.photos.pages;
      const photos = res.photos?.photo ?? [];

      for (const photo of photos) {
        if (kept.length >= limit) break;
        if (!OK_LICENSES.has(photo.license ?? "")) continue;
        if (!this.imageUrlOf(photo)) continue;

        // One work per normalized title per run — Commons streams contain
        // many near-duplicate scans (plates from one book, photo variants).
        const label = this.titleOf(photo).toLowerCase().replace(/\s+/g, " ");
        if (seenTitle.has(label)) continue;
        seenTitle.add(label);

        kept.push(photo);
      }

      // Advance, wrapping back to the first page at the end of the stream.
      page = page + 1 > totalPages ? 1 : page + 1;
      if (kept.length < limit && read + 1 < MAX_PAGES_PER_ACCOUNT) {
        await sleep(PAGE_PAUSE_MS);
      }
    }

    this.nextPages[account.nsid] = page;
    return kept;
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private mapPhoto(
    photo: FlickrPhoto,
    account: FlickrAccount,
  ): { artwork: Artwork; artistId: string; artistName: string } {
    const institution = (photo.ownername ?? "").trim() || "Flickr Commons";
    // Commons photos rarely credit an individual maker — the institution is
    // the honest attribution, and one profile per institution keeps the feed
    // browsable (mirrors how the app shows "Unknown Artist" pools elsewhere).
    const artistName = institution;
    const artistId = `flickr-artist-${slugify(institution)}`;

    const description = stripHtml(photo.description?._content);
    const tags = this.readableTags(photo.tags);
    const medium = account.mediumHint ?? "";

    const signals = {
      mediumDisplay: medium,
      termTitles: [medium, ...tags],
    };
    const empire = inferEmpire(signals);

    return {
      artistId,
      artistName,
      artwork: {
        id: `flickr-${photo.id}`,
        title: this.titleOf(photo),
        artistId,
        year: this.yearLabelOf(photo, description),
        period: medium || "—",
        medium: medium || "—",
        source: `${institution} (Flickr Commons)`,
        image: this.imageUrlOf(photo),
        accent: this.accentFor(photo.id),
        description: this.concise(description) || this.titleOf(photo),
        tags: uniqueTags([medium, ...tags]),
        category: inferCategory(signals),
        origin: "public-domain",
        ...(empire ? { empire } : {}),
      },
    };
  }

  private buildArtist(acc: { id: string; name: string; works: number }): Artist {
    return {
      id: acc.id,
      name: acc.name,
      initials: initialsOf(acc.name),
      profileType: "historical",
      lifespan: "—",
      nationality: "—",
      period: "—",
      style: "Archive collection",
      knownFor: "Public-domain archive collection",
      bio:
        `${acc.name} publishes its public-domain collection on Flickr Commons ` +
        `under "no known copyright restrictions".`,
      followers: seededInt(acc.id, 5_000, 900_000),
      likes: seededInt(acc.id + ":likes", 20_000, 3_000_000),
      saves: seededInt(acc.id + ":saves", 8_000, 500_000),
    };
  }

  // ── Field extraction helpers ────────────────────────────────────────────

  /** Prefer ~800px (matches the ingest width), then 1024, 500, original. */
  private imageUrlOf(photo: FlickrPhoto): string {
    return (photo.url_c || photo.url_l || photo.url_m || photo.url_o || "").trim();
  }

  private titleOf(photo: FlickrPhoto): string {
    const raw = stripHtml(photo.title).replace(/\s+/g, " ").trim();
    if (!raw) return "Untitled";
    const MAX = 60;
    if (raw.length <= MAX) return raw;
    const slice = raw.slice(0, MAX);
    const sp = slice.lastIndexOf(" ");
    return `${slice.slice(0, sp > 0 ? sp : MAX).trim()}…`;
  }

  /**
   * Human-readable tags. Flickr's `tags` field is a space-separated list of
   * lowercased, de-spaced machine tags ("mechanicalcurator bldigital") — keep
   * only short plain words that read like real labels.
   */
  private readableTags(tags: string | undefined): string[] {
    return (tags ?? "")
      .split(/\s+/)
      .filter((t) => /^[a-z]{3,16}$/.test(t))
      .slice(0, 8);
  }

  /**
   * Work date. `datetaken` is usually the SCAN/upload date, so instead pull
   * the first plausible year from the description (BL descriptions carry
   * "Date of Publishing: 1878"; LOC ones often state the photo date), then
   * the title.
   */
  private yearLabelOf(photo: FlickrPhoto, description: string): string {
    const explicit = description.match(/date of publishing:?\s*\[?(\d{4})/i);
    if (explicit) return explicit[1];
    const anywhere = `${photo.title ?? ""} ${description}`.match(
      /\b(1[4-9]\d\d|20[0-2]\d)\b/,
    );
    return anywhere ? anywhere[1] : "Date unknown";
  }

  /** Trim long descriptions to a short, card-friendly blurb. */
  private concise(text: string, max = 240): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;

    const slice = clean.slice(0, max);
    const lastStop = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
    );
    if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1).trim();

    const lastSpace = slice.lastIndexOf(" ");
    return `${slice.slice(0, lastSpace > 0 ? lastSpace : max).trim()}…`;
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private accentFor(seed: string): string {
    const hue = hashString(seed) % 360;
    return hslToHex(hue, 32, 26) || DEFAULT_ACCENT;
  }
}
