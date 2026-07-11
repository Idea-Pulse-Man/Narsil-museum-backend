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
