/**
 * Helpers for streaming artwork images through the download API.
 */

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Turn a title into a safe attachment filename base. */
export function slugifyFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "artwork";
}

/** Map a MIME type to a file extension, defaulting to jpg. */
export function extForType(type: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "image/svg+xml": "svg",
  };
  return map[type] || "jpg";
}

/**
 * Width of the free-tier download. The paid tier gets the original.
 *
 * 2000px is a real photo — fine for a phone wallpaper, a social post or a
 * 6×8" print — while leaving a visible gap to the master, which for most
 * museum scans is 3000–6000px wide.
 */
export const STANDARD_DOWNLOAD_WIDTH = 2000;

/** IIIF size segment in `{base}/{id}/{region}/{size}/{rotation}/{quality}.{fmt}`. */
const IIIF_PATH = /\/full\/(max|full|\d+,|,\d+|!\d+,\d+|pct:[\d.]+)\/(\d+)\//;

/**
 * Resolve the image URL for a download at a given width.
 *
 * Every image family in the catalogue can be resized by URL alone, so neither
 * tier costs us any image processing — the upstream does the work:
 *
 *   · our IIIF proxy      → `?w=` / `?full=1`   (routes/image.ts)
 *   · a direct IIIF URL   → rewrite the size segment
 *   · Wikimedia Commons   → `?width=`
 *   · wsrv.nl             → `&w=`
 *   · raw S3 / Flickr     → no width parameter of their own, so the standard
 *                           tier is routed through wsrv.nl (already used by the
 *                           frontend grid) and the paid tier gets the original
 *
 * `width = null` means "largest available".
 */
export function downloadImageUrl(
  src: string,
  publicBaseUrl: string,
  width: number | null,
): string {
  if (!src) return src;

  // Our own IIIF proxy — it already understands both tiers.
  const proxyPath = src.startsWith("/api/")
    ? `${publicBaseUrl.replace(/\/$/, "")}${src}`
    : src;
  if (proxyPath.includes("/api/image/")) {
    const url = new URL(proxyPath);
    url.searchParams.delete("w");
    url.searchParams.delete("full");
    if (width) url.searchParams.set("w", String(width));
    else url.searchParams.set("full", "1");
    return url.toString();
  }

  // wsrv.nl wrapper — unwrap first so the paid tier gets untouched bytes.
  if (src.includes("wsrv.nl")) {
    try {
      const original = new URL(src).searchParams.get("url");
      if (original) {
        return downloadImageUrl(decodeURIComponent(original), publicBaseUrl, width);
      }
    } catch {
      /* fall through */
    }
  }

  // Wikimedia Commons — `Special:FilePath` serves the original with no width.
  if (src.includes("commons.wikimedia.org/wiki/Special:FilePath")) {
    const bare = src.replace(/([?&])width=\d+/g, "$1").replace(/[?&]$/, "");
    if (!width) return bare;
    return `${bare}${bare.includes("?") ? "&" : "?"}width=${width}`;
  }

  // A direct IIIF Image API URL — rewrite the size segment in place.
  if (IIIF_PATH.test(src)) {
    return src.replace(IIIF_PATH, (_m, _size, rotation) =>
      width ? `/full/${width},/${rotation}/` : `/full/max/${rotation}/`,
    );
  }

  // Raw S3 / Flickr CDN — no native resize. Full size is the original; the
  // standard tier borrows wsrv.nl, which the frontend grid already relies on.
  if (!width) return src;
  return `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=${width}&output=jpg&q=85`;
}

/**
 * Resolve the full-size image URL for download. Strips display-only transforms
 * (Wikimedia width, wsrv.nl thumbnails) so we fetch the original bytes.
 */
export function fullResImageUrl(src: string, publicBaseUrl: string): string {
  if (!src) return src;

  // wsrv.nl CDN wrapper used by the frontend grid — unwrap to the source URL.
  if (src.includes("wsrv.nl")) {
    try {
      const original = new URL(src).searchParams.get("url");
      if (original) return decodeURIComponent(original);
    } catch {
      /* fall through */
    }
  }

  if (src.includes("commons.wikimedia.org/wiki/Special:FilePath")) {
    return src.replace(/([?&])width=\d+/g, "$1").replace(/[?&]$/, "");
  }

  // Relative backend proxy path → absolute URL for server-side fetch.
  if (src.startsWith("/api/")) {
    return `${publicBaseUrl.replace(/\/$/, "")}${src}`;
  }

  return src;
}

/** Fetch image bytes server-side (no browser CORS restrictions). */
export async function fetchImageBytes(
  imageUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(imageUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Referer: safeOrigin(imageUrl),
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`Image fetch failed: HTTP ${res.status}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error("Image fetch returned an empty body");
    }

    return {
      buffer,
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } finally {
    clearTimeout(timer);
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin + "/";
  } catch {
    return url;
  }
}
