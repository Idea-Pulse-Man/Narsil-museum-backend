/**
 * Centralised, validated environment configuration.
 *
 * Everything the app reads from `process.env` funnels through here so the rest
 * of the codebase works with typed, defaulted values instead of raw strings.
 */
import "dotenv/config";

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const items = value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

const corsOrigins = list(process.env.CORS_ORIGIN, [
  "http://localhost:5173",
  "http://localhost:3000",
  "https://narsil-app-frontend.vercel.app",
]);

const imageDelivery =
  process.env.IMAGE_DELIVERY === "direct" ? "direct" : "proxy";

const KNOWN_MUSEUM_SOURCES = ["wellcome", "artic", "met"] as const;
export type MuseumSourceId = (typeof KNOWN_MUSEUM_SOURCES)[number];

/** Source-specific defaults for the API + IIIF endpoints (env can override). */
export const SOURCE_DEFAULTS = {
  wellcome: {
    api: "https://api.wellcomecollection.org/catalogue/v2",
    iiif: "https://iiif.wellcomecollection.org/image",
  },
  artic: {
    api: "https://api.artic.edu/api/v1",
    iiif: "https://www.artic.edu/iiif/2",
  },
  met: {
    api: "https://collectionapi.metmuseum.org/public/collection/v1",
    // The Met has no IIIF Image API — each object carries a ready-made image
    // URL. This entry only exists so SOURCE_DEFAULTS stays uniform; MetSource
    // ignores it (see src/museum/met.ts).
    iiif: "https://images.metmuseum.org",
  },
} as const;

/**
 * Which museum Public API(s) to source from, e.g. "wellcome,met".
 *  - "wellcome" (default): Wellcome Collection. Serves genuine IIIF Image API
 *    3.0 images that the backend can fetch and stream, so images always display
 *    regardless of the browser's network.
 *  - "artic": Art Institute of Chicago. Richer fine-art metadata, but its IIIF
 *    image server (www.artic.edu) blocks non-browser clients, so images can
 *    only be delivered via redirect and may be unreachable on some networks.
 *  - "met": The Metropolitan Museum of Art. CC0 (public domain), no API key,
 *    ~490k objects. Carries ready-made image URLs (no IIIF); re-hosting to S3
 *    and permanent storage are allowed and safe for commercial use.
 *
 * `MUSEUM_SOURCES` (comma list) is read first; `MUSEUM_SOURCE` (singular) is
 * kept as a back-compat alias when `MUSEUM_SOURCES` is unset, so existing
 * single-source deploys don't break silently.
 */
function parseMuseumSources(): MuseumSourceId[] {
  const raw = process.env.MUSEUM_SOURCES ?? process.env.MUSEUM_SOURCE;
  const items = list(raw, ["wellcome"]).filter(
    (s): s is MuseumSourceId =>
      (KNOWN_MUSEUM_SOURCES as readonly string[]).includes(s),
  );
  return items.length > 0 ? items : ["wellcome"];
}

const museumSources = parseMuseumSources();
/** The first active source — kept for single-source consumers (live catalog cache, boot log). */
const museumSource = museumSources[0];
const sourceDefaults = SOURCE_DEFAULTS[museumSource];
const catalogLimit = num(process.env.CATALOG_LIMIT, 80);

export const env = {
  port: num(process.env.PORT, 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",

  /** `"*"` (allow any) or an explicit allow-list of origins. */
  corsOrigin: corsOrigins.includes("*") ? ("*" as const) : corsOrigins,

  /**
   * Absolute origin of THIS backend, used to build proxied image URLs so the
   * frontend can load images from the same host it calls the API on.
   */
  publicBaseUrl: (
    process.env.PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ??
    `http://localhost:${num(process.env.PORT, 4000)}`
  ).replace(/\/$/, ""),

  /** How artwork images reach the frontend: "proxy" (default) or "direct". */
  imageDelivery: imageDelivery as "proxy" | "direct",

  museum: {
    /** The first active source — single-source consumers (live catalog cache, boot log). */
    source: museumSource,
    /** All active sources, comma list via MUSEUM_SOURCES — read by the ingest job. */
    sources: museumSources,
    /** Base URL of the museum Public API (applies to the first active source). */
    apiBaseUrl: (
      process.env.MUSEUM_API_BASE_URL ?? sourceDefaults.api
    ).replace(/\/$/, ""),
    /** How many public-domain artworks to ingest per source. */
    catalogLimit,
    /** In-memory cache lifetime for the built catalog. */
    cacheTtlMs: num(process.env.CATALOG_CACHE_TTL_MS, 60 * 60 * 1000),
  },

  iiif: {
    /**
     * Base URL of the IIIF Image API 3.0 server. Empty string means
     * "auto-discover from the museum API config.iiif_url" (Artic only).
     */
    baseUrl: (process.env.IIIF_BASE_URL ?? sourceDefaults.iiif).replace(
      /\/$/,
      "",
    ),
    /** Requested image width; maps to the IIIF size parameter "{width},". */
    imageWidth: num(process.env.IIIF_IMAGE_WIDTH, 800),
  },

  /**
   * Daily ingestion job (`npm run ingest`). Downloads public-domain art,
   * uploads the images to S3, and upserts artworks + artists into Supabase.
   * Only the ingestion job reads these — the web API never does.
   */
  aws: {
    region: process.env.AWS_REGION ?? "us-east-2",
    /** Target S3 bucket for images. */
    s3Bucket: process.env.S3_BUCKET ?? "",
    /** Key prefix (folder) for artwork images — must be publicly readable. */
    s3Prefix: (process.env.S3_PREFIX ?? "artworks").replace(/^\/|\/$/g, ""),
    /**
     * Key prefix for artist portrait images. Defaults to a subfolder of the
     * artwork prefix so it's covered by the same public bucket policy
     * (`artworks/*`) — no extra AWS change needed.
     */
    s3ArtistPrefix: (process.env.S3_ARTIST_PREFIX ?? "artworks/artists").replace(
      /^\/|\/$/g,
      "",
    ),
    /**
     * Public base URL objects are served from (no trailing slash). For a
     * public bucket: https://<bucket>.s3.<region>.amazonaws.com
     * For CloudFront later: https://<distribution>.cloudfront.net
     */
    s3PublicBaseUrl: (process.env.S3_PUBLIC_BASE_URL ?? "").replace(/\/$/, ""),
  },

  supabase: {
    url: (process.env.SUPABASE_URL ?? "").replace(/\/$/, ""),
    /** SERVICE ROLE key (server-side only — bypasses RLS to write the catalog). */
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  },

  ingest: {
    /** Width (px) of the image uploaded to S3 (IIIF size "{width},"). */
    imageWidth: num(process.env.INGEST_IMAGE_WIDTH, 843),
    /** Skip re-downloading images already present in S3. */
    skipExisting: process.env.INGEST_SKIP_EXISTING !== "false",
    /** Max concurrent image downloads/uploads. */
    concurrency: num(process.env.INGEST_CONCURRENCY, 6),
    /** Resolve artist portraits (Wikidata) and store them in S3. */
    artistPhotos: process.env.INGEST_ARTIST_PHOTOS !== "false",
  },
} as const;

export type Env = typeof env;
