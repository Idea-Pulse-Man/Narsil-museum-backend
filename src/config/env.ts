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

const KNOWN_MUSEUM_SOURCES = [
  "wellcome",
  "artic",
  "met",
  "cma",
  "rijks",
  "flickr",
] as const;
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
  cma: {
    api: "https://openaccess-api.clevelandart.org/api",
    // Like the Met, CMA records carry ready-made CDN image URLs — no IIIF.
    // This entry only keeps SOURCE_DEFAULTS uniform; CmaSource ignores it.
    iiif: "https://openaccess-cdn.clevelandart.org",
  },
  rijks: {
    api: "https://data.rijksmuseum.nl",
    // Rijksmuseum images ARE served via a IIIF Image API (micr.io), but each
    // object's full image URL is discovered through its Linked Art records, so
    // RijksSource never builds URLs from this base — kept for uniformity.
    iiif: "https://iiif.micr.io",
  },
  flickr: {
    api: "https://api.flickr.com/services/rest",
    // Flickr photos carry ready-made CDN URLs — no IIIF. Kept for uniformity.
    iiif: "https://live.staticflickr.com",
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
 *  - "cma": Cleveland Museum of Art Open Access. CC0, no API key, ~41k works
 *    with images, first-party `cc0=1&has_image=1` filters and ready-made CDN
 *    image URLs — the friendliest source for ingestion.
 *  - "rijks": Rijksmuseum, via the new Data Services (data.rijksmuseum.nl)
 *    Search API + Linked Art resolver + IIIF images. No API key. Only works
 *    whose image carries a public-domain rights mark are kept.
 *  - "flickr": Flickr Commons photostreams — by default the Library of
 *    Congress and the British Library, whose own APIs are unusable
 *    server-side (Cloudflare wall / post-cyber-attack outage). Needs the
 *    free FLICKR_API_KEY; only "no known copyright restrictions"/CC0/PD
 *    photos are kept. Skipped with a notice while the key is unset.
 *
 * `MUSEUM_SOURCES` (comma list) is read first; `MUSEUM_SOURCE` (singular) is
 * kept as a back-compat alias when `MUSEUM_SOURCES` is unset, so existing
 * single-source deploys don't break silently. Names that aren't in
 * KNOWN_MUSEUM_SOURCES are dropped with a warning — a silent drop costs a whole
 * ingest run before anyone notices the typo.
 */
function parseMuseumSources(): MuseumSourceId[] {
  const raw = process.env.MUSEUM_SOURCES ?? process.env.MUSEUM_SOURCE;
  const requested = list(raw, ["wellcome"]);
  const known = new Set<string>(KNOWN_MUSEUM_SOURCES);
  const items = requested.filter((s): s is MuseumSourceId => known.has(s));

  const unknown = requested.filter((s) => !known.has(s));
  if (unknown.length > 0) {
    console.warn(
      `MUSEUM_SOURCES: ignoring unknown source${unknown.length > 1 ? "s" : ""}` +
        ` ${unknown.join(", ")} — known: ${KNOWN_MUSEUM_SOURCES.join(", ")}`,
    );
  }
  if (items.length === 0) {
    console.warn(
      'MUSEUM_SOURCES: no valid source listed — falling back to "wellcome".',
    );
    return ["wellcome"];
  }
  return items;
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

  /**
   * Canvas checkout (Stripe payment → Printful fulfillment).
   * The frontend never talks to Stripe's secret API or Printful directly:
   * it asks this backend for a PaymentIntent, pays with Stripe.js, and the
   * backend submits the Printful order once the payment has succeeded.
   */
  stripe: {
    /** Secret key (sk_test_… / sk_live_…). Checkout routes 503 while unset. */
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    /** Signing secret (whsec_…) for the /api/stripe/webhook endpoint. */
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  },

  printful: {
    /** Private API token (https://developers.printful.com). */
    apiKey: process.env.PRINTFUL_API_KEY ?? "",
    /** Store id — required when the token has access to multiple stores. */
    storeId: process.env.PRINTFUL_STORE_ID ?? "",
    /**
     * Shared secret for the status webhook (Printful doesn't sign payloads,
     * so the URL carries it: /api/printful/webhook?secret=<this>). The
     * webhook answers 503 while unset.
     */
    webhookSecret: process.env.PRINTFUL_WEBHOOK_SECRET ?? "",
    /**
     * Submit orders for fulfillment immediately ("true") or create drafts to
     * confirm by hand in the Printful dashboard (default — safe for dev).
     */
    confirmOrders: process.env.PRINTFUL_CONFIRM_ORDERS === "true",
    /** Printful catalog product used for canvas prints (3 = Canvas (in)). */
    canvasProductId: num(process.env.PRINTFUL_CANVAS_PRODUCT_ID, 3),
    /**
     * Optional explicit catalog variant ids per app size. When unset, the
     * variant is discovered from the Printful catalog by matching the size
     * dimensions (12×16 / 18×24 / 24×36 inches).
     */
    variantIds: {
      Small: num(process.env.PRINTFUL_VARIANT_SMALL, 0) || null,
      Medium: num(process.env.PRINTFUL_VARIANT_MEDIUM, 0) || null,
      Large: num(process.env.PRINTFUL_VARIANT_LARGE, 0) || null,
    } as Record<"Small" | "Medium" | "Large", number | null>,
  },

  checkout: {
    /** ISO currency the canvas prices are charged in. */
    currency: (process.env.CHECKOUT_CURRENCY ?? "usd").toLowerCase(),
  },

  /**
   * Narsil Pro — the Apple auto-renewing subscription (iOS only).
   *
   * The app buys through StoreKit and hands the signed transaction to
   * POST /api/apple/verify; Apple pushes lifecycle changes to
   * POST /api/apple/notifications. Both verify signatures against Apple's root
   * CAs before anything is written, so every credential below is required for
   * the tier to run. While ANY of them is unset the whole subscription tier
   * no-ops: nobody is a subscriber, canvas checkout and free downloads are
   * unaffected (same kill-switch convention as the AI description tier).
   */
  apple: {
    /**
     * App Store Connect API private key — the contents of the .p8 file, PEM
     * included. Newlines may be escaped as \n for single-line env storage.
     */
    privateKey: (process.env.APPLE_PRIVATE_KEY ?? "").replace(/\\n/g, "\n"),
    /** Key ID of that .p8 (App Store Connect → Users and Access → Keys). */
    keyId: process.env.APPLE_KEY_ID ?? "",
    /** Issuer ID from the same page (a UUID, shared by all your keys). */
    issuerId: process.env.APPLE_ISSUER_ID ?? "",
    /** Must match the app's bundle id exactly or signature checks fail. */
    bundleId: process.env.APPLE_BUNDLE_ID ?? "com.narsil.museum",
    /** Numeric App ID from App Store Connect (App Information → Apple ID). */
    appAppleId: num(process.env.APPLE_APP_APPLE_ID, 0) || null,
    /**
     * Which App Store environment this deployment talks to. Sandbox for TestFlight
     * and simulator builds, Production for the live app. A Sandbox transaction
     * verified against Production (or vice versa) is rejected.
     */
    environment: (process.env.APPLE_ENVIRONMENT === "Sandbox"
      ? "Sandbox"
      : "Production") as "Production" | "Sandbox",
    /**
     * Directory holding Apple's root CA certificates (.cer, DER) used to verify
     * signed payloads. Download from https://www.apple.com/certificateauthority/
     * — "Apple Root CA - G3" is the one that signs App Store data.
     */
    rootCaDir: process.env.APPLE_ROOT_CA_DIR ?? "certs/apple",
    /** Product ids of the subscription, for sanity-checking transactions. */
    productIds: list(process.env.APPLE_PRODUCT_IDS, [
      "com.narsil.museum.pro.monthly",
      "com.narsil.museum.pro.annual",
    ]),
  },

  /**
   * AI placard descriptions (`npm run backfill:descriptions` + ingest).
   * Only thin/boilerplate records are generated for — good museum prose is
   * never rewritten. While the key is unset the whole tier silently no-ops
   * and placards keep their deterministic wall text.
   */
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    /** Chat model used for wall-text generation. */
    model: process.env.OPENAI_MODEL ?? "gpt-5.5",
  },

  flickr: {
    /** Free API key (https://www.flickr.com/services/api/keys/). While unset,
     *  the "flickr" source is skipped with a notice instead of failing. */
    apiKey: process.env.FLICKR_API_KEY ?? "",
    /**
     * Flickr Commons account NSIDs to pull from. Defaults (see
     * museum/flickr.ts): The Library of Congress + The British Library.
     */
    accounts: list(process.env.FLICKR_ACCOUNTS, []),
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
