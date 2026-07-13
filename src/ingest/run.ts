/**
 * Daily ingestion job.
 * ---------------------------------------------------------------------------
 * 1. Pull a catalog of public-domain artworks + artists from the museum source
 *    (Wellcome by default — its IIIF images are downloadable server-side;
 *    Artic's WAF blocks non-browser clients, so it can't be ingested to S3).
 * 2. For each artwork, download the IIIF image and upload it to S3 (skipping
 *    images already stored), rewriting `image` to the public S3 URL.
 * 3. Upsert artists + artworks into Supabase, keyed on their TEXT id, so the
 *    app can read the whole catalog directly from Supabase.
 *
 * Run locally:   npm run ingest
 * Run on EC2:    npm run build && npm run ingest:prod   (via cron)
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, SOURCE_DEFAULTS } from "../config/env.js";
import { IiifImageService } from "../museum/iiif.js";
import { ImageResolver } from "../museum/imaging.js";
import { ArticSource } from "../museum/artic.js";
import { WellcomeSource } from "../museum/wellcome.js";
import { MetSource } from "../museum/met.js";
import { getArtistPhotoUrl } from "../museum/artistPhoto.js";
import type { MuseumSource } from "../museum/source.js";
import type { Artwork, Artist } from "../types/domain.js";
import { S3ImageStore } from "./s3.js";
import { SupabaseCatalogStore } from "./store.js";

/** S3 object key for an artwork image, e.g. "artworks/wc-abc.jpg". */
function artworkKey(id: string): string {
  return `${env.aws.s3Prefix}/${id}.jpg`;
}

/** S3 object key for an artist portrait, e.g. "artworks/artists/wc-x.jpg". */
function artistKey(id: string): string {
  return `${env.aws.s3ArtistPrefix}/${id}.jpg`;
}

// ── Resume cursor ───────────────────────────────────────────────────────────
// Persisted next-page marker so each run pulls a DIFFERENT slice of the museum
// collection (the catalog grows instead of re-fetching the same works). Stored
// next to the repo; safe to delete (a reset just re-covers from page 1, and
// existing images/rows are skipped/upserted, never duplicated).
const STATE_PATH = join(process.cwd(), ".ingest-state.json");

interface IngestState {
  wellcomeNextPage?: number;
  metNextIndex?: number;
}

function readState(): IngestState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as IngestState;
  } catch {
    return {};
  }
}

function writeState(state: IngestState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn(
      `  (could not persist ingest cursor: ${err instanceof Error ? err.message : err})`,
    );
  }
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Wikimedia Commons requires a descriptive User-Agent identifying the bot and a
 * contact URL, and rate-limits hard (HTTP 429) otherwise. See
 * https://meta.wikimedia.org/wiki/User-Agent_policy
 */
const WIKIMEDIA_HEADERS: Record<string, string> = {
  "User-Agent":
    "NarsilMuseumBot/1.0 (https://github.com/Idea-Pulse-Man/Narsil-museum-backend) ingestion",
  Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
};

class RetryableError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfterMs: number,
  ) {
    super(`retryable ${status}`);
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Direct delivery → `artwork.image` is the raw upstream IIIF URL we download.
function buildImages(iiifBaseUrl: string, pinned: boolean): ImageResolver {
  const iiif = new IiifImageService(iiifBaseUrl, env.ingest.imageWidth, pinned);
  return new ImageResolver(iiif, "direct", env.publicBaseUrl);
}

/**
 * Build one `MuseumSource` per entry in `MUSEUM_SOURCES`. The legacy
 * `MUSEUM_API_BASE_URL` / `IIIF_BASE_URL` overrides only apply to the first
 * (primary) source — same behaviour as before multi-source support existed —
 * every other source always uses its own fixed defaults.
 */
function buildSources(state: IngestState): MuseumSource[] {
  return env.museum.sources.map((id): MuseumSource => {
    const isPrimary = id === env.museum.source;

    if (id === "met") {
      // The Met source reads metadata from the Open Access CSV and resolves
      // images from object-page og:image tags — no museum API, no IIIF.
      const startIndex = Math.max(0, Number(state.metNextIndex) || 0);
      return new MetSource(env.museum.catalogLimit, startIndex);
    }

    const apiBaseUrl = isPrimary ? env.museum.apiBaseUrl : SOURCE_DEFAULTS[id].api;
    const iiifBaseUrl = isPrimary ? env.iiif.baseUrl : SOURCE_DEFAULTS[id].iiif;
    const pinned = isPrimary ? Boolean(process.env.IIIF_BASE_URL) : true;
    const images = buildImages(iiifBaseUrl, pinned);

    if (id === "artic") {
      return new ArticSource(apiBaseUrl, images, env.museum.catalogLimit);
    }

    const startPage = Math.max(1, Number(state.wellcomeNextPage) || 1);
    return new WellcomeSource(apiBaseUrl, images, env.museum.catalogLimit, startPage);
  });
}

function assertConfig(): void {
  const missing: string[] = [];
  if (!env.aws.s3Bucket) missing.push("S3_BUCKET");
  if (!env.aws.s3PublicBaseUrl) missing.push("S3_PUBLIC_BASE_URL");
  if (!env.supabase.url) missing.push("SUPABASE_URL");
  if (!env.supabase.serviceRoleKey) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (missing.length) {
    throw new Error(
      `Ingestion is missing required env vars: ${missing.join(", ")}. ` +
        `Set them in the .env file (see .env.example).`,
    );
  }
  if (env.museum.sources.includes("artic")) {
    console.warn(
      "WARNING: MUSEUM_SOURCES includes 'artic' — the Art Institute IIIF " +
        "server blocks server-side downloads (403), so its images will fail. " +
        "Remove 'artic' from MUSEUM_SOURCES for ingestion.",
    );
  }
}

interface DownloadOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Number of retries on 429/503/timeout (with exponential backoff). */
  retries?: number;
}

async function downloadOnce(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (res.status === 429 || res.status === 503) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      throw new RetryableError(res.status, retryAfter * 1000);
    }
    if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error(`GET ${url} → empty body`);
    return { buffer, contentType: res.headers.get("content-type") ?? "image/jpeg" };
  } finally {
    clearTimeout(timer);
  }
}

async function download(
  url: string,
  opts: DownloadOptions = {},
): Promise<{ buffer: Buffer; contentType: string }> {
  const { timeoutMs = 20_000, headers = BROWSER_HEADERS, retries = 2 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await downloadOnce(url, headers, timeoutMs);
    } catch (err) {
      lastErr = err;
      const isRetryable =
        err instanceof RetryableError ||
        (err instanceof Error && err.name === "AbortError");
      if (attempt >= retries || !isRetryable) throw err;
      const backoff =
        err instanceof RetryableError && err.retryAfterMs > 0
          ? err.retryAfterMs
          : 800 * 2 ** attempt;
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/** Run `fn` over `items` with a fixed concurrency limit. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    worker,
  );
  await Promise.all(workers);
  return results;
}

interface Stats {
  uploaded: number;
  skipped: number;
  failed: number;
}

/** Ensure every artwork's image is in S3; rewrite `image` to the S3 URL. */
async function stageImages(artworks: Artwork[], s3: S3ImageStore): Promise<{
  ready: Artwork[];
  stats: Stats;
}> {
  const stats: Stats = { uploaded: 0, skipped: 0, failed: 0 };

  const staged = await mapLimit(
    artworks,
    env.ingest.concurrency,
    async (art): Promise<Artwork | null> => {
      const upstream = art.image;
      if (!upstream) {
        stats.failed++;
        return null;
      }
      const key = artworkKey(art.id);
      try {
        if (env.ingest.skipExisting && (await s3.exists(key))) {
          stats.skipped++;
          return { ...art, image: s3.publicUrl(key) };
        }
        const { buffer, contentType } = await download(upstream);
        const url = await s3.upload(key, buffer, contentType);
        stats.uploaded++;
        return { ...art, image: url };
      } catch (err) {
        stats.failed++;
        console.warn(
          `  ✗ ${art.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    },
  );

  return { ready: staged.filter((a): a is Artwork => a !== null), stats };
}

/**
 * Resolve each artist's portrait (Wikidata, server-side) and store it in S3,
 * setting `artist.avatar` to the public S3 URL. Artists with no resolvable
 * portrait (anonymous makers, workshops, etc.) are returned unchanged and fall
 * back to a monogram in the app. Never throws — a failed portrait is non-fatal.
 */
async function stageArtistPhotos(
  artists: Artist[],
  s3: S3ImageStore,
): Promise<{ artists: Artist[]; stats: Stats }> {
  const stats: Stats = { uploaded: 0, skipped: 0, failed: 0 };

  // Wikimedia rate-limits aggressively — keep portrait fetching gentle.
  const portraitConcurrency = Math.min(2, env.ingest.concurrency);

  const staged = await mapLimit(
    artists,
    portraitConcurrency,
    async (artist): Promise<Artist> => {
      const key = artistKey(artist.id);
      try {
        if (env.ingest.skipExisting && (await s3.exists(key))) {
          stats.skipped++;
          return { ...artist, avatar: s3.publicUrl(key) };
        }
        const portraitUrl = await getArtistPhotoUrl(artist.name);
        if (!portraitUrl) return artist; // no portrait → monogram
        const { buffer, contentType } = await download(portraitUrl, {
          headers: WIKIMEDIA_HEADERS,
          retries: 4,
        });
        const url = await s3.upload(key, buffer, contentType);
        stats.uploaded++;
        return { ...artist, avatar: url };
      } catch (err) {
        stats.failed++;
        console.warn(
          `  ✗ artist ${artist.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return artist;
      }
    },
  );

  return { artists: staged, stats };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  assertConfig();

  const state = readState();
  const sources = buildSources(state);

  console.log(
    `Ingest: sources=${env.museum.sources.join(",")} limit=${env.museum.catalogLimit}` +
      ` width=${env.ingest.imageWidth} → s3://${env.aws.s3Bucket}/${env.aws.s3Prefix}`,
  );

  const s3 = new S3ImageStore();
  const store = new SupabaseCatalogStore();

  console.log("1/4 Fetching catalogs from museum APIs…");
  const artworks: Artwork[] = [];
  const artists: Artist[] = [];
  for (const source of sources) {
    const data = await source.fetchCatalog();
    artworks.push(...data.artworks);
    artists.push(...data.artists);
  }
  console.log(`     got ${artworks.length} artworks, ${artists.length} artists (combined)`);

  console.log("2/4 Uploading artwork images to S3…");
  const { ready, stats } = await stageImages(artworks, s3);
  console.log(
    `     uploaded=${stats.uploaded} skipped=${stats.skipped} failed=${stats.failed}`,
  );

  let finalArtists = artists;
  if (env.ingest.artistPhotos) {
    console.log("3/4 Resolving + uploading artist portraits to S3…");
    const photos = await stageArtistPhotos(artists, s3);
    finalArtists = photos.artists;
    const withPhoto = finalArtists.filter((a) => a.avatar).length;
    console.log(
      `     uploaded=${photos.stats.uploaded} skipped=${photos.stats.skipped} ` +
        `failed=${photos.stats.failed} (with portrait: ${withPhoto}/${finalArtists.length})`,
    );
  } else {
    console.log("3/4 Artist portraits disabled (INGEST_ARTIST_PHOTOS=false).");
  }

  console.log("4/4 Upserting into Supabase…");
  await store.upsertArtists(finalArtists);
  await store.upsertArtworks(ready);

  // Advance each source's cursor only after a successful upsert, so a failed
  // run retries the same slice next time instead of skipping it.
  const nextState: IngestState = { ...state };
  for (const source of sources) {
    if (source instanceof WellcomeSource) {
      nextState.wellcomeNextPage = source.nextStartPage;
      console.log(`     next run resumes at Wellcome page ${source.nextStartPage}`);
    } else if (source instanceof MetSource) {
      nextState.metNextIndex = source.nextStartIndex;
      console.log(`     next run resumes at Met index ${source.nextStartIndex}`);
    }
  }
  writeState(nextState);

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `Done in ${secs}s — ${ready.length} artworks + ${finalArtists.length} artists live.`,
  );
}

main().catch((err) => {
  console.error("Ingestion failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
