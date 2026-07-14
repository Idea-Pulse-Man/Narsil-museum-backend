/**
 * Cleveland Museum of Art — Open Access API source.
 * ---------------------------------------------------------------------------
 * Docs: https://openaccess-api.clevelandart.org/
 *
 * The friendliest source in the roster: no API key, first-party filters for
 * exactly what we ingest (`cc0=1&has_image=1`), and every record carries a
 * ready-made CDN image URL (`images.web` — ~900px JPEG on
 * openaccess-cdn.clevelandart.org), so there is no second lookup per object
 * like The Met needs. Works with `share_license_status: "CC0"` are dedicated
 * to the public domain, so re-hosting images to S3 and storing rows in
 * Supabase is explicitly permitted and safe for commercial use.
 *
 * Rate limits are not documented; pages are fetched sequentially with a pause
 * so a daily run stays far below anything that could look like a crawl.
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
  firstSentence,
  uniqueTags,
  hslToHex,
  hashString,
} from "../utils/text.js";

// ── Upstream API shapes (only the fields we read) ───────────────────────────

interface CmaCreator {
  /** e.g. "Paolo Veronese (Italian, 1528–1588)" */
  description?: string | null;
  role?: string | null;
  biography?: string | null;
  birth_year?: string | null;
  death_year?: string | null;
}

interface CmaImage {
  url?: string | null;
}

interface CmaArtworkRecord {
  id: number;
  accession_number?: string | null;
  share_license_status?: string | null;
  title?: string | null;
  creation_date?: string | null;
  creation_date_earliest?: number | null;
  creation_date_latest?: number | null;
  culture?: (string | null)[] | null;
  technique?: string | null;
  department?: string | null;
  collection?: string | null;
  type?: string | null;
  description?: string | null;
  did_you_know?: string | null;
  creditline?: string | null;
  creators?: CmaCreator[] | null;
  images?: { web?: CmaImage | null; print?: CmaImage | null } | null;
}

interface CmaListResponse {
  info?: { total?: number };
  data?: CmaArtworkRecord[];
}

const PAGE_SIZE = 50;
/** Pages fetched beyond the strict minimum, covering records dropped by the
 *  image/label filters. Also the hard page cap for one run. */
const PAGE_BUFFER = 4;
/** Pause between pages — undocumented rate limits, so stay visibly gentle. */
const PAGE_PAUSE_MS = 500;
/** Max artworks with the same (title + artist) kept per run (see met.ts). */
const MAX_PER_LABEL = 1;
const DEFAULT_ACCENT = "#22242b";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class CmaSource implements MuseumSource {
  /**
   * How many CC0-with-image rows the NEXT run should skip before collecting,
   * so daily runs walk a fresh slice of the collection. Read by the ingest job.
   */
  nextStartSkip: number;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly limit: number,
    /** Rows to skip before collecting (the API's `skip` param). Defaults to 0. */
    private readonly startSkip = 0,
  ) {
    this.nextStartSkip = Math.max(0, startSkip);
  }

  async fetchCatalog(): Promise<CatalogData> {
    const records = await this.collectRecords();
    if (records.length < this.limit) {
      console.warn(
        `  (CMA: kept ${records.length}/${this.limit} works — this slice may ` +
          `be image-sparse, or the collection wrapped. Re-run to continue.)`,
      );
    }
    return this.mapCatalog(records);
  }

  // ── Ingestion ─────────────────────────────────────────────────────────────

  /**
   * Page through `cc0=1&has_image=1` records from `startSkip`, keeping those
   * that actually resolve a web image, until `limit` works are collected. The
   * resume cursor advances past every row consumed (kept or dropped) and wraps
   * to 0 at the end of the collection.
   */
  private async collectRecords(): Promise<CmaArtworkRecord[]> {
    const kept: CmaArtworkRecord[] = [];
    const labelCount = new Map<string, number>();
    const maxPages = Math.ceil(this.limit / PAGE_SIZE) + PAGE_BUFFER;

    let skip = Math.max(0, this.startSkip);
    let total = Number.POSITIVE_INFINITY;

    for (let page = 0; page < maxPages && kept.length < this.limit; page++) {
      const url =
        `${this.apiBaseUrl}/artworks/?cc0=1&has_image=1` +
        `&skip=${skip}&limit=${PAGE_SIZE}`;
      const res = await fetchJsonRetry<CmaListResponse>(url);
      if (typeof res.info?.total === "number") total = res.info.total;
      const rows = res.data ?? [];

      // Ran off the end of the collection → wrap the cursor for the next run.
      if (rows.length === 0) {
        skip = 0;
        if (page === 0) break; // empty collection — nothing to wrap into
        continue;
      }

      for (const record of rows) {
        if (kept.length >= this.limit) break;
        skip++;
        if ((record.share_license_status ?? "").toUpperCase() !== "CC0") continue;
        if (!this.imageUrlOf(record)) continue;

        // Cap generically-titled works (e.g. dozens of "Pendant") so one run
        // doesn't flood the feed with visually repetitive objects.
        const label = this.dedupLabelOf(record);
        if ((labelCount.get(label) ?? 0) >= MAX_PER_LABEL) continue;
        labelCount.set(label, (labelCount.get(label) ?? 0) + 1);

        kept.push(record);
      }

      if (skip >= total) skip = 0;
      if (kept.length < this.limit && page + 1 < maxPages) {
        await sleep(PAGE_PAUSE_MS);
      }
    }

    this.nextStartSkip = skip;
    return kept;
  }

  private dedupLabelOf(record: CmaArtworkRecord): string {
    const title = this.titleOf(record).toLowerCase().replace(/\s+/g, " ").trim();
    return `${this.artistIdOf(this.artistNameOf(record))}::${title}`;
  }

  // ── Mapping (identical shape to any other MuseumSource) ─────────────────────

  private mapCatalog(records: CmaArtworkRecord[]): CatalogData {
    interface ArtistAccumulator {
      id: string;
      name: string;
      nationality: string;
      bio: string;
      birthYear: string;
      deathYear: string;
      styles: string[];
      years: number[];
    }

    const artistAcc = new Map<string, ArtistAccumulator>();
    const artworks: Artwork[] = [];

    for (const record of records) {
      const creator = (record.creators ?? [])[0];
      const name = this.artistNameOf(record);
      const artistId = this.artistIdOf(name);

      const acc =
        artistAcc.get(artistId) ??
        ({
          id: artistId,
          name,
          nationality: this.nationalityOf(creator),
          bio: stripHtml(creator?.biography),
          birthYear: (creator?.birth_year ?? "").trim(),
          deathYear: (creator?.death_year ?? "").trim(),
          styles: [],
          years: [],
        } satisfies ArtistAccumulator);

      const style = record.type?.trim();
      if (style) acc.styles.push(style);
      if (typeof record.creation_date_earliest === "number") {
        acc.years.push(record.creation_date_earliest);
      }
      artistAcc.set(artistId, acc);

      artworks.push(this.mapArtwork(record, artistId));
    }

    const artists = Array.from(artistAcc.values()).map((acc) => this.buildArtist(acc));
    return { artworks, artists };
  }

  private mapArtwork(record: CmaArtworkRecord, artistId: string): Artwork {
    const cultures = (record.culture ?? []).filter(
      (c): c is string => Boolean(c && c.trim()),
    );

    // Deliberately NO departmentTitle: CMA department names bundle media
    // ("American Painting and Sculpture"), which mis-routes the category.
    const signals = {
      classification: record.type,
      classifications: [record.collection].filter(Boolean) as string[],
      mediumDisplay: record.technique,
      placeOfOrigin: cultures.join(" "),
      termTitles: [record.type, record.technique, ...cultures].filter(
        Boolean,
      ) as string[],
    };

    const empire = inferEmpire(signals);

    return {
      id: `cma-${record.id}`,
      title: this.titleOf(record),
      artistId,
      year: this.yearLabelOf(record),
      period: cultures[0] || record.collection || record.department || "—",
      medium: record.technique?.trim() || "—",
      // The placard's MUSEUM line — the institution, never the donor credit.
      source: "The Cleveland Museum of Art",
      image: this.imageUrlOf(record),
      accent: this.accentFor(String(record.id)),
      description: this.describe(record),
      tags: uniqueTags([
        record.type,
        record.technique,
        record.department,
        ...cultures,
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
    birthYear: string;
    deathYear: string;
    styles: string[];
    years: number[];
  }): Artist {
    const nationality = acc.nationality || "—";
    const style = this.mostCommon(acc.styles) || "—";
    const lifespan = this.lifespanOf(acc.birthYear, acc.deathYear, acc.years);
    const period = style !== "—" ? style : this.centuryOf(this.avg(acc.years));

    const bio =
      this.concise(acc.bio) ||
      `${acc.name}${lifespan !== "—" ? ` (${lifespan})` : ""} is represented in ` +
        `the Open Access collection of the Cleveland Museum of Art.`;

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
      saves: seededInt(acc.id + ":saves", 8_000, 500_000),
    };
  }

  // ── Field extraction helpers ────────────────────────────────────────────

  private imageUrlOf(record: CmaArtworkRecord): string {
    return (record.images?.web?.url ?? "").trim();
  }

  /** Creator name from "Paolo Veronese (Italian, 1528–1588)" → "Paolo Veronese". */
  private artistNameOf(record: CmaArtworkRecord): string {
    const description = (record.creators ?? [])[0]?.description ?? "";
    const name = description.split("(")[0].replace(/\s+/g, " ").trim();
    return name || "Unknown Artist";
  }

  /** Nationality from the creator parenthetical, e.g. "(Italian, 1528–1588)". */
  private nationalityOf(creator: CmaCreator | undefined): string {
    const paren = (creator?.description ?? "").match(/\(([^)]+)\)/);
    if (!paren) return "";
    const lead = paren[1].split(",")[0].trim();
    return /\d/.test(lead) ? "" : lead;
  }

  private artistIdOf(name: string): string {
    return name === "Unknown Artist"
      ? "cma-unknown-artist"
      : `cma-artist-${slugify(name)}`;
  }

  private titleOf(record: CmaArtworkRecord): string {
    return stripHtml(record.title).trim() || record.type?.trim() || "Untitled";
  }

  private describe(record: CmaArtworkRecord): string {
    const description = this.concise(stripHtml(record.description));
    if (description) return description;
    const didYouKnow = this.concise(stripHtml(record.did_you_know));
    if (didYouKnow) return didYouKnow;

    const parts: string[] = [];
    const artist = this.artistNameOf(record);
    if (artist !== "Unknown Artist") parts.push(artist);
    if (record.technique) parts.push(record.technique.trim());
    if (record.creation_date) parts.push(record.creation_date.trim());
    const culture = (record.culture ?? []).find(Boolean);
    if (culture) parts.push(`Culture: ${culture.trim()}`);
    return (
      parts.join(" · ") ||
      `${this.titleOf(record)} from the collection of the Cleveland Museum of Art.`
    );
  }

  /** Trim long gallery descriptions to a short, card-friendly blurb. */
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

  private yearLabelOf(record: CmaArtworkRecord): string {
    const dated = (record.creation_date ?? "").trim();
    if (dated) return dated;
    const begin = record.creation_date_earliest;
    const end = record.creation_date_latest;
    if (typeof begin === "number" && typeof end === "number") {
      return begin === end ? String(begin) : `${begin} – ${end}`;
    }
    return "Date unknown";
  }

  private lifespanOf(birth: string, death: string, fallback: number[]): string {
    if (birth && death) return `${birth} – ${death}`;
    if (birth) return `b. ${birth}`;
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
