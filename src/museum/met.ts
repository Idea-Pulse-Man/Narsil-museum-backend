/**
 * The Metropolitan Museum of Art — Open Access source (CSV + og:image).
 * ---------------------------------------------------------------------------
 * Docs: https://github.com/metmuseum/openaccess , https://metmuseum.github.io/
 *
 * A CC0, key-free source. Every object flagged `Is Public Domain` in The Met's
 * Open Access data is released under a Creative Commons Zero dedication, so
 * re-hosting the image to S3 and storing the row in Supabase is explicitly
 * permitted, and the data is safe for commercial use.
 *
 * Why the CSV (and not the JSON API): The Met's Public API
 * (collectionapi.metmuseum.org) rate-limits hard (HTTP 403/429) once a backfill
 * fires enough requests, and there is no "public-domain + has-image" query
 * filter — so discovering usable objects meant scanning thousands of records
 * and getting throttled. Instead this source reads The Met's bulk Open Access
 * CSV (hosted on GitHub, NOT a Met server, so never Met-rate-limited), which
 * carries every field we need — title, artist, bio, dating, medium, culture,
 * credit line, tags AND the `Is Public Domain` flag — entirely offline.
 *
 * The one thing the CSV lacks is the image URL. We resolve it per kept object
 * from that object's public page `og:image` meta tag (www.metmuseum.org — a
 * different host than the blocked API), then rewrite it to the ~800px
 * "web-large" variant and hand it to the ingest job to download + re-host to S3
 * exactly like any other source. Page fetches are paced and retried with
 * backoff; a persistent throttle fails the run loudly rather than silently
 * ingesting a handful.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parse } from "csv-parse";
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

// ── The domain shape we map into (populated from CSV columns) ───────────────

interface MetTag {
  term?: string;
}

interface MetObject {
  objectID: number;
  primaryImageSmall?: string;
  primaryImage?: string;
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

const CSV_URL =
  "https://media.githubusercontent.com/media/metmuseum/openaccess/master/MetObjects.csv";
const CACHE_DIR = ".met-cache";
const CACHE_FILE = "MetObjects.csv";

/** Extra public-domain rows to pull per run beyond `limit`, to cover the few
 *  whose page has no resolvable image. */
const ROW_BUFFER = 2;
/** Object pages fetched concurrently when resolving og:image. Modest, to stay
 *  under www.metmuseum.org's rate limit. */
const IMG_BATCH = 4;
/** Pause between og:image batches. */
const BATCH_PAUSE_MS = 150;
/** Per-page retries on a rate-limit / transient error. */
const IMG_RETRIES = 4;
const DEFAULT_ACCENT = "#22242b";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** A non-OK HTTP response, carrying the status so callers can tell a
 *  rate-limit (403/429/503) apart from a plain miss (404). */
class MetHttpError extends Error {
  constructor(
    public readonly status: number,
    url: string,
  ) {
    super(`GET ${url} → ${status}`);
  }
}

/** Thrown when The Met keeps rate-limiting page fetches even after retries.
 *  The run fails loudly instead of silently ingesting a handful of works. */
class MetRateLimitError extends Error {}

const BROWSER_UA =
  "Mozilla/5.0 (compatible; NarsilMuseumBot/1.0; " +
  "+https://github.com/Idea-Pulse-Man/Narsil-museum-backend)";

function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status === 500 || status === 503;
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/html,*/*", "User-Agent": BROWSER_UA },
    });
    if (!res.ok) throw new MetHttpError(res.status, url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export class MetSource implements MuseumSource {
  /**
   * How many public-domain CSV rows the NEXT run should skip before collecting,
   * so daily runs walk a fresh slice of the collection. Read by the ingest job.
   */
  nextStartIndex: number;
  private skipBase = 0;

  constructor(
    private readonly limit: number,
    /** Public-domain rows to skip before collecting. Defaults to 0. */
    private readonly startIndex = 0,
  ) {
    this.nextStartIndex = Math.max(0, startIndex);
  }

  async fetchCatalog(): Promise<CatalogData> {
    const rows = await this.collectPublicDomainRows();
    const { kept, consumed } = await this.attachImages(rows);
    this.nextStartIndex = this.skipBase + consumed;

    if (kept.length < this.limit) {
      console.warn(
        `  (Met: kept ${kept.length}/${this.limit} works — the object pages ` +
          `may be rate-limiting, or this slice is image-sparse. Re-run to continue.)`,
      );
    }
    return this.mapCatalog(kept);
  }

  // ── CSV ingestion ─────────────────────────────────────────────────────────

  /**
   * Stream the Open Access CSV, skip `startIndex` public-domain rows, then
   * collect the next `limit * ROW_BUFFER` public-domain rows (with metadata).
   * Stops reading the 318 MB file as soon as it has enough.
   */
  private async collectPublicDomainRows(): Promise<MetObject[]> {
    const path = await this.ensureCsv();
    this.skipBase = Math.max(0, this.startIndex);
    const target = this.limit * ROW_BUFFER;

    const rows: MetObject[] = [];
    let pdSeen = 0;

    const parser = createReadStream(path).pipe(
      parse({
        columns: true,
        bom: true,
        relaxQuotes: true,
        relaxColumnCount: true,
        skipRecordsWithError: true,
      }),
    );

    try {
      for await (const rec of parser as AsyncIterable<Record<string, string>>) {
        if ((rec["Is Public Domain"] ?? "").trim().toLowerCase() !== "true") {
          continue;
        }
        pdSeen++;
        if (pdSeen <= this.skipBase) continue;
        const obj = this.rowToObject(rec);
        if (Number.isFinite(obj.objectID) && obj.objectURL) rows.push(obj);
        if (rows.length >= target) break;
      }
    } finally {
      parser.destroy();
    }

    // Ran off the end of the collection → wrap the cursor for the next run.
    if (rows.length < target) this.skipBase = 0;
    return rows;
  }

  /** Download the CSV to a local cache once (skipped if already present). */
  private async ensureCsv(): Promise<string> {
    const dir = join(process.cwd(), CACHE_DIR);
    const file = join(dir, CACHE_FILE);
    if (existsSync(file) && statSync(file).size > 1_000_000) return file;

    mkdirSync(dir, { recursive: true });
    console.log("     downloading The Met Open Access CSV (~318 MB, one-time)…");
    const res = await fetch(CSV_URL, { headers: { "User-Agent": BROWSER_UA } });
    if (!res.ok || !res.body) {
      throw new Error(`Met CSV download failed: ${res.status} ${res.statusText}`);
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(file),
    );
    console.log(`     CSV cached at ${file}`);
    return file;
  }

  private rowToObject(rec: Record<string, string>): MetObject {
    const val = (k: string): string | undefined => {
      const v = (rec[k] ?? "").trim();
      return v || undefined;
    };
    const int = (k: string): number | undefined => {
      const n = Number(rec[k]);
      return Number.isFinite(n) ? n : undefined;
    };
    const tags = (rec["Tags"] ?? "")
      .split("|")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((term) => ({ term }));

    const link = val("Link Resource");
    return {
      objectID: Number(rec["Object ID"]),
      title: val("Title"),
      objectName: val("Object Name"),
      culture: val("Culture"),
      period: val("Period"),
      dynasty: val("Dynasty"),
      reign: val("Reign"),
      artistDisplayName: val("Artist Display Name"),
      artistDisplayBio: val("Artist Display Bio"),
      artistNationality: val("Artist Nationality"),
      artistBeginDate: val("Artist Begin Date"),
      artistEndDate: val("Artist End Date"),
      objectDate: val("Object Date"),
      objectBeginDate: int("Object Begin Date"),
      objectEndDate: int("Object End Date"),
      medium: val("Medium"),
      classification: val("Classification"),
      department: val("Department"),
      creditLine: val("Credit Line"),
      objectURL: link ? link.replace(/^http:\/\//, "https://") : undefined,
      tags,
    };
  }

  // ── Image resolution (og:image) ─────────────────────────────────────────

  /**
   * Resolve each row's image from its object page, keeping only rows that yield
   * one, until we have `limit`. Returns the kept rows plus how many rows we
   * consumed (so the caller can advance the resume cursor precisely).
   */
  private async attachImages(
    rows: MetObject[],
  ): Promise<{ kept: MetObject[]; consumed: number }> {
    const kept: MetObject[] = [];
    let consumed = 0;

    for (let i = 0; i < rows.length && kept.length < this.limit; i += IMG_BATCH) {
      const batch = rows.slice(i, i + IMG_BATCH);
      const urls = await Promise.all(batch.map((r) => this.resolveImage(r)));
      for (let j = 0; j < batch.length; j++) {
        consumed++;
        if (urls[j]) {
          kept.push({ ...batch[j], primaryImageSmall: urls[j]! });
          if (kept.length >= this.limit) break;
        }
      }
      if (kept.length < this.limit && i + IMG_BATCH < rows.length) {
        await sleep(BATCH_PAUSE_MS);
      }
    }

    return { kept, consumed };
  }

  /**
   * Fetch an object page and pull the `og:image` URL, rewritten to the
   * ~800px "web-large" variant. Retries rate-limit / transient errors with
   * backoff; a persistent throttle throws `MetRateLimitError` (fail loudly). A
   * page with no usable image resolves to null (skip that object).
   */
  private async resolveImage(row: MetObject): Promise<string | null> {
    const pageUrl = row.objectURL;
    if (!pageUrl) return null;

    for (let attempt = 0; attempt <= IMG_RETRIES; attempt++) {
      try {
        const html = await fetchText(pageUrl);
        const raw = this.ogImageOf(html);
        // Accept a Met image host or any plain image URL; reject a non-image
        // og:image (some pages fall back to a logo when there's no artwork).
        if (!raw) return null;
        if (!/metmuseum\.org/i.test(raw) && !/\.(jpe?g|png)(\?|$)/i.test(raw)) {
          return null;
        }
        // The web-large variant is ~800px — plenty for the app, far smaller
        // than the multi-MB "original".
        return raw.replace("/original/", "/web-large/");
      } catch (err) {
        const retryable =
          (err instanceof MetHttpError && isRetryableStatus(err.status)) ||
          (err instanceof Error && err.name === "AbortError");
        if (!retryable) return null;
        if (attempt >= IMG_RETRIES) {
          throw new MetRateLimitError(
            "The Met object pages keep rate-limiting (HTTP 403/429). Wait " +
              "~15-30 min and re-run, and/or lower CATALOG_LIMIT.",
          );
        }
        await sleep(1000 * 2 ** attempt + (row.objectID % 37) * 12);
      }
    }
    return null;
  }

  private ogImageOf(html: string): string | null {
    const patterns = [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return m[1];
    }
    return null;
  }

  // ── Mapping (identical shape to any other MuseumSource) ─────────────────────

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
      saves: seededInt(acc.id + ":saves", 8_000, 500_000),
    };
  }

  // ── Field extraction helpers ────────────────────────────────────────────

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
