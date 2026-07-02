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
]);

const imageDelivery =
  process.env.IMAGE_DELIVERY === "direct" ? "direct" : "proxy";

/**
 * Which museum Public API to source from.
 *  - "wellcome" (default): Wellcome Collection. Serves genuine IIIF Image API
 *    3.0 images that the backend can fetch and stream, so images always display
 *    regardless of the browser's network.
 *  - "artic": Art Institute of Chicago. Richer fine-art metadata, but its IIIF
 *    image server (www.artic.edu) blocks non-browser clients, so images can
 *    only be delivered via redirect and may be unreachable on some networks.
 */
const museumSource =
  process.env.MUSEUM_SOURCE === "artic" ? "artic" : "wellcome";

/** Source-specific defaults for the API + IIIF endpoints (env can override). */
const SOURCE_DEFAULTS = {
  wellcome: {
    api: "https://api.wellcomecollection.org/catalogue/v2",
    iiif: "https://iiif.wellcomecollection.org/image",
  },
  artic: {
    api: "https://api.artic.edu/api/v1",
    iiif: "https://www.artic.edu/iiif/2",
  },
} as const;

const sourceDefaults = SOURCE_DEFAULTS[museumSource];

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
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${num(process.env.PORT, 4000)}`
  ).replace(/\/$/, ""),

  /** How artwork images reach the frontend: "proxy" (default) or "direct". */
  imageDelivery: imageDelivery as "proxy" | "direct",

  museum: {
    /** Which upstream museum source to use ("wellcome" | "artic"). */
    source: museumSource as "wellcome" | "artic",
    /** Base URL of the museum Public API. */
    apiBaseUrl: (
      process.env.MUSEUM_API_BASE_URL ?? sourceDefaults.api
    ).replace(/\/$/, ""),
    /** How many public-domain artworks to ingest. */
    catalogLimit: num(process.env.CATALOG_LIMIT, 80),
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
} as const;

export type Env = typeof env;
