/**
 * The Metropolitan Museum of Art — Open Access source.
 * ---------------------------------------------------------------------------
 * Docs: https://metmuseum.github.io/
 *
 * A CC0, key-free source. Every object flagged `isPublicDomain` is released
 * under a Creative Commons Zero dedication, so re-hosting the image to S3 and
 * storing the row in Supabase is explicitly permitted, and the data is safe for
 * commercial use.
 *
 * Unlike Wellcome/Artic, The Met does NOT expose a IIIF Image API: each
 * object carries a ready-made image URL (`primaryImageSmall`, a ~800px "web
 * large" JPEG on images.metmuseum.org). This source therefore sets `image` to
 * that URL directly and does not touch `IiifImageService` — the ingest job
 * downloads it and re-hosts it to S3 exactly the same way.
 *
 * The API has two relevant endpoints:
 *   GET /search?hasImages=true&…  → { total, objectIDs: number[] }  (image-bearing only)
 *   GET /objects/{id}             → full object record
 * There is no "isPublicDomain" query filter, so this source pages the
 * image-bearing id list from a persisted cursor, fetching records concurrently
 * and keeping the public-domain ones, until it has `limit` of them.
 *
 * Why /search and not /objects: /objects returns ALL ~490k ids, most of which
 * have no image (or aren't public-domain), so walking it sequentially gives a
 * dismal hit rate (a barren stretch can yield <1%). /search?hasImages=true
 * returns only the ~366k objects that actually have an image, so almost every
 * scanned record is a real candidate.
 */
import type { Artwork, Artist } from "../types/domain.js";
import type { CatalogData, MuseumSource } from "./source.js";
import { inferCategory, inferEmpire } from "./taxonomy.js";
import {
  stripHtml,
  slugify,
  initialsOf,
  seededInt,
  firstSentence,
  uniqueTags,
  hslToHex,
  hashString,
} from "../utils/text.js";

// ── Upstream API shapes (only the fields we use) ───────────────────────────

interface MetTag {
  term?: string;
}

interface MetObject {
  objectID: number;
  isPublicDomain?: boolean;
  primaryImage?: string;
  primaryImageSmall?: string;
  title?: string;
  objectName?: string;
  culture?: string;
  period?: string;
  dynasty?: string;
  reign?: string;
  artistDisplayName?: string;
  artistDisplayBio?: string;
  artistNationality?: string;
  artistBeginDate?: string;
  artistEndDate?: string;
  objectDate?: string;
  objectBeginDate?: number;
  objectEndDate?: number;
  medium?: string;
  classification?: string;
  department?: string;
  creditLine?: string;
  objectURL?: string;
  tags?: MetTag[] | null;
}

interface MetObjectsResponse {
  total?: number;
  objectIDs?: number[] | null;
}

/** How many object records to request concurrently per batch. Kept modest so
 *  a big backfill stays well under The Met's rate limit. */
const FETCH_BATCH = 5;
/** Small pause between batches, as further rate-limit insurance. */
const BATCH_PAUSE_MS = 120;
/** Per-object detail-fetch retries on a rate-limit / transient error. */
const DETAIL_RETRIES = 4;
const DEFAULT_ACCENT = "#22242b";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A non-OK HTTP response from The Met, carrying the status so callers can
 *  tell a rate-limit (403/429/503) apart from a plain miss (404). */
class MetHttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`GET ${url} → ${status}`);
  }
}

/** Thrown when The Met keeps rate-limiting us even after retries. The run
 *  fails loudly instead of silently ingesting a handful of works. */
class MetRateLimitError extends Error {}

/**
 * `fetch` + typed JSON with a browser-style User-Agent (The Met 403s some bot
 * agents) and a timeout. Throws `MetHttpError` (with status) on a non-OK
 * response so the retry layer can react to it.
 */
async function fetchMetJson<T>(url: string, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; NarsilMuseumBot/1.0; " +
          "+https://github.com/Idea-Pulse-Man/Narsil-museum-backend)",
      },
    });
    if (!res.ok) throw new MetHttpError(res.status, url);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Rate-limit / transient statuses worth backing off and retrying. */
function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status === 500 || status === 503;
}

export class MetSource implements MuseumSource {
  /**
   * Index into the object-id list the NEXT run should resume from, so daily
   * runs walk a fresh slice of the collection (wrapping at the end) rather than
   * re-scanning the same ids. Read by the ingestion job.
   */
  nextStartIndex: number;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly limit: number,
    /** Index into the id list to begin scanning from. Defaults to 0. */
    private readonly startIndex = 0,
  ) {
    this.nextStartIndex = Math.max(0, startIndex);
  }

  async fetchCatalog(): Promise<CatalogData> {
    const objects = await this.collectObjects();
    return this.mapCatalog(objects);
  }

  // ── Ingestion ───────────────────────────────────────────────────────────

  /**
   * Walk the object-id list from `startIndex`, fetching records concurrently
   * and keeping public-domain works that have an image, until we have `limit`
   * of them (or we've scanned a generous cap, so a sparse slice can't loop
   * forever).
   */
  private async collectObjects(): Promise<MetObject[]> {
    const ids = await this.fetchObjectIds();
    const total = ids.length;
    if (total === 0) return [];

    const start = ((this.startIndex % total) + total) % total; // safe wrap
    // The shuffled pool has a uniform public-domain rate, so a modest cap
    // suffices — and it stops a sparse run from hammering the API for ages.
    const scanCap = Math.min(total, this.limit * 12 + 500);

    const kept: MetObject[] = [];
    let idx = start;
    let scanned = 0;

    while (kept.length < this.limit && scanned < scanCap) {
      const batchIds: number[] = [];
      for (let i = 0; i < FETCH_BATCH && scanned < scanCap; i++) {
        batchIds.push(ids[idx]);
        idx = (idx + 1) % total;
        scanned++;
      }

      const records = await this.fetchObjects(batchIds);
      for (const record of records) {
        if (record?.isPublicDomain && this.imageUrlOf(record)) {
          kept.push(record);
          if (kept.length >= this.limit) break;
        }
      }
      if (kept.length < this.limit && scanned < scanCap) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    // Where the next run should resume (wrapped past the ids we scanned).
    this.nextStartIndex = (start + scanned) % total;

    if (kept.length < this.limit) {
      console.warn(
        `  (Met: scanned ${scanned} ids but only found ${kept.length}/` +
          `${this.limit} public-domain works — raise the scan or try again)`,
      );
    }
    return kept;
  }

  /**
   * The ids of every object that HAS an image, via the search endpoint, then
   * deterministically shuffled. One (large) call per run.
   *
   * `q=*` with a date range spanning the whole collection matches everything;
   * `hasImages=true` restricts it to image-bearing objects (~366k). The shuffle
   * spreads public-domain works — which cluster at the low (older) object ids —
   * evenly across the list, so ANY resume-cursor position sees the same high
   * hit rate. A fixed seed keeps the order stable across runs, so the cursor
   * still resumes correctly.
   */
  private async fetchObjectIds(): Promise<number[]> {
    const res = await fetchMetJson<MetObjectsResponse>(
      `${this.apiBaseUrl}/search` +
        `?hasImages=true&dateBegin=-5000&dateEnd=3000&q=*`,
      30_000,
    );
    const ids = [...(res.objectIDs ?? [])].sort((a, b) => a - b);
    return this.deterministicShuffle(ids);
  }

  /** Fetch a batch of object records concurrently. A persistent rate-limit
   *  bubbles up (via fetchObjectDetail) and aborts the whole run. */
  private async fetchObjects(ids: number[]): Promise<(MetObject | null)[]> {
    return Promise.all(ids.map((id) => this.fetchObjectDetail(id)));
  }

  /**
   * Fetch one object record, retrying with exponential backoff on rate-limit /
   * transient errors. A plain miss (404) resolves to null (skip the object); a
   * rate-limit that survives every retry throws `MetRateLimitError` so the run
   * fails loudly rather than silently ingesting almost nothing.
   */
  private async fetchObjectDetail(id: number): Promise<MetObject | null> {
    const url = `${this.apiBaseUrl}/objects/${id}`;
    for (let attempt = 0; attempt <= DETAIL_RETRIES; attempt++) {
      try {
        return await fetchMetJson<MetObject>(url);
      } catch (err) {
        const retryable =
          (err instanceof MetHttpError && isRetryableStatus(err.status)) ||
          (err instanceof Error && err.name === "AbortError");
        if (!retryable) return null; // 404 etc. — just skip this object
        if (attempt >= DETAIL_RETRIES) {
          throw new MetRateLimitError(
            "The Met API keeps rate-limiting requests (HTTP 403/429). Wait " +
              "~15-30 min and re-run, and/or lower CATALOG_LIMIT.",
          );
        }
        // Exponential backoff with jitter: ~0.8s, 1.6s, 3.2s, 6.4s (+0-400ms).
        await sleep(800 * 2 ** attempt + Math.floor((id % 41) * 10));
      }
    }
    return null;
  }

  /** Fisher–Yates shuffle driven by a fixed-seed PRNG (mulberry32), so the
   *  order is random but identical on every run. */
  private deterministicShuffle(ids: number[]): number[] {
    const arr = [...ids];
    let seed = 0x9e3779b9;
    const rand = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private mapCatalog(objects: MetObject[]): CatalogData {
    interface ArtistAccumulator {
      id: string;
      name: string;
      nationality: string;
      bio: string;
      beginDate: string;
      endDate: string;
      styles: string[];
      years: number[];
    }

    const artistAcc = new Map<string, ArtistAccumulator>();
    const artworks: Artwork[] = [];

    for (const record of objects) {
      const name = this.artistNameOf(record);
      const artistId = this.artistIdOf(name);

      const acc =
        artistAcc.get(artistId) ??
        ({
          id: artistId,
          name,
          nationality: (record.artistNationality ?? "").trim(),
          bio: stripHtml(record.artistDisplayBio),
          beginDate: (record.artistBeginDate ?? "").trim(),
          endDate: (record.artistEndDate ?? "").trim(),
          styles: [],
          years: [],
        } satisfies ArtistAccumulator);

      const style = record.classification?.trim();
      if (style) acc.styles.push(style);
      const year = this.startYearOf(record);
      if (year != null) acc.years.push(year);
      artistAcc.set(artistId, acc);

      artworks.push(this.mapArtwork(record, artistId));
    }

    const artists = Array.from(artistAcc.values()).map((acc) => this.buildArtist(acc));
    return { artworks, artists };
  }

  private mapArtwork(record: MetObject, artistId: string): Artwork {
    const tags = (record.tags ?? [])
      .map((t) => t?.term)
      .filter((t): t is string => Boolean(t));

    const signals = {
      classification: record.classification,
      classifications: [record.objectName].filter(Boolean) as string[],
      mediumDisplay: record.medium,
      styleTitles: [record.period, record.dynasty, record.reign].filter(
        Boolean,
      ) as string[],
      placeOfOrigin: record.culture,
      departmentTitle: record.department,
      termTitles: [record.classification, record.objectName, ...tags].filter(
        Boolean,
      ) as string[],
    };

    const empire = inferEmpire(signals);

    return {
      id: `met-${record.objectID}`,
      title: this.titleOf(record),
      artistId,
      year: this.yearLabelOf(record),
      period:
        record.period ||
        record.dynasty ||
        record.classification ||
        record.department ||
        "—",
      medium: record.medium?.trim() || "—",
      source: record.creditLine?.trim() || "The Metropolitan Museum of Art",
      image: this.imageUrlOf(record),
      accent: this.accentFor(String(record.objectID)),
      description: this.describe(record),
      tags: uniqueTags([
        record.classification,
        record.objectName,
        record.culture,
        record.period,
        ...tags,
      ]),
      category: inferCategory(signals),
      origin: "public-domain",
      ...(empire ? { empire } : {}),
    };
  }

  private buildArtist(acc: {
    id: string;
    name: string;
    nationality: string;
    bio: string;
    beginDate: string;
    endDate: string;
    styles: string[];
    years: number[];
  }): Artist {
    const nationality = acc.nationality || "—";
    const style = this.mostCommon(acc.styles) || "—";
    const lifespan = this.lifespanOf(acc.beginDate, acc.endDate, acc.years);
    const period = style !== "—" ? style : this.centuryOf(this.avg(acc.years));

    const bio =
      acc.bio ||
      `${acc.name}${lifespan !== "—" ? ` (${lifespan})` : ""} is represented in ` +
        `the Open Access collection of The Metropolitan Museum of Art.`;

    return {
      id: acc.id,
      name: acc.name,
      initials: initialsOf(acc.name),
      profileType: "historical",
      lifespan,
      nationality,
      period: period || "—",
      style,
      knownFor: firstSentence(acc.bio) || (style !== "—" ? style : "Museum collection"),
      bio,
      // No social graph upstream — synthesise stable, plausible numbers.
      followers: seededInt(acc.id, 5_000, 900_000),
      likes: seededInt(acc.id + ":likes", 20_000, 3_000_000),
      saves: seededInt(acc.id + ":saves", 8_000, 800_000),
    };
  }

  // ── Field extraction helpers ────────────────────────────────────────────

  /** Prefer the ~800px "web large" image; fall back to the full-res one. */
  private imageUrlOf(record: MetObject): string {
    return (record.primaryImageSmall || record.primaryImage || "").trim();
  }

  private artistNameOf(record: MetObject): string {
    return (record.artistDisplayName ?? "").trim() || "Unknown Artist";
  }

  private artistIdOf(name: string): string {
    return name === "Unknown Artist"
      ? "met-unknown-artist"
      : `met-artist-${slugify(name)}`;
  }

  private titleOf(record: MetObject): string {
    const raw = stripHtml(record.title).trim();
    return raw || record.objectName?.trim() || "Untitled";
  }

  private describe(record: MetObject): string {
    const parts: string[] = [];
    if (record.artistDisplayName) parts.push(record.artistDisplayName.trim());
    if (record.medium) parts.push(record.medium.trim());
    if (record.objectDate) parts.push(record.objectDate.trim());
    if (record.culture) parts.push(`Culture: ${record.culture.trim()}`);
    const composed = parts.join(" · ");
    return (
      composed ||
      `${this.titleOf(record)} from the collection of The Metropolitan Museum of Art.`
    );
  }

  private yearLabelOf(record: MetObject): string {
    const dated = (record.objectDate ?? "").trim();
    if (dated) return dated;
    if (
      typeof record.objectBeginDate === "number" &&
      typeof record.objectEndDate === "number"
    ) {
      return record.objectBeginDate === record.objectEndDate
        ? String(record.objectBeginDate)
        : `${record.objectBeginDate} – ${record.objectEndDate}`;
    }
    return "Date unknown";
  }

  private startYearOf(record: MetObject): number | null {
    if (typeof record.objectBeginDate === "number") return record.objectBeginDate;
    const m = (record.objectDate ?? "").match(/-?\d{3,4}/);
    return m ? Number(m[0]) : null;
  }

  private lifespanOf(begin: string, end: string, fallback: number[]): string {
    const b = begin.replace(/\s+/g, "");
    const e = end.replace(/\s+/g, "");
    if (b && e && b !== "0" && e !== "0") return `${b} – ${e}`;
    if (b && b !== "0") return `b. ${b}`;
    return this.centuryOf(this.avg(fallback)) || "—";
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private accentFor(seed: string): string {
    const hue = hashString(seed) % 360;
    return hslToHex(hue, 32, 26) || DEFAULT_ACCENT;
  }

  private centuryOf(year: number | null): string {
    if (year == null) return "";
    if (year < 0) return `c. ${Math.abs(year)} BC`;
    return `${Math.floor(year / 100) + 1}th century`;
  }

  private avg(values: number[]): number | null {
    if (values.length === 0) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }

  private mostCommon(values: string[]): string {
    if (values.length === 0) return "";
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = "";
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  }
}
