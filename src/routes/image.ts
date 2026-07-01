import { Router } from "express";
import type { IiifImageService } from "../museum/iiif.js";

/**
 * IIIF image proxy — resilient delivery.
 * ---------------------------------------------------------------------------
 * `GET /api/image/:identifier` builds the IIIF Image API 3.0 URL for the given
 * image identifier and delivers the image using the best available strategy:
 *
 *   1. STREAM — fetch the IIIF image server-side (with browser-style headers)
 *      and pipe the bytes back. The frontend then loads every image from this
 *      backend's own origin (no CORS/hotlink issues). Works for image servers
 *      that permit server-side requests (Getty, Wellcome, most IIIF servers).
 *
 *   2. REDIRECT — some museum image servers (notably the Art Institute of
 *      Chicago's `www.artic.edu/iiif`) sit behind a WAF that returns `403` to
 *      non-browser HTTP clients like Node's `fetch`, even with browser headers,
 *      because it fingerprints the TLS/client — not just the User-Agent. When a
 *      server-side fetch is refused, we `302` the browser to the direct IIIF 3.0
 *      URL. Real browsers pass the WAF, so the `<img>` loads normally. This is
 *      what turns the previous `502 Bad Gateway` into a working image.
 *
 * Hosts that refuse server-side fetches are remembered so subsequent requests
 * skip straight to the redirect (no repeated failed round-trips).
 *
 * Optional query params:
 *   ?w=<px>   requested width (IIIF size "{w},")
 *   ?full=1   request the IIIF 3.0 "max" size
 */

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Upstream statuses that mean "this host won't serve the backend" → redirect. */
const REFUSAL_STATUSES = new Set([401, 403, 429, 451]);

/** Image servers learned to block server-side fetches; redirect immediately. */
const redirectOnlyHosts = new Set<string>();

export function imageRoutes(iiif: IiifImageService): Router {
  const router = Router();

  router.get("/:identifier", async (req, res) => {
    const { identifier } = req.params;
    const full = req.query.full === "1" || req.query.full === "true";
    const width = Number(req.query.w);

    const upstream = iiif.imageUrl(identifier, {
      full,
      width: Number.isFinite(width) && width > 0 ? width : undefined,
    });
    if (!upstream) {
      res.status(400).json({ error: "Bad Request", message: "Missing image identifier" });
      return;
    }

    const host = safeHost(upstream);

    // Known WAF host → let the browser load the IIIF URL directly.
    if (host && redirectOnlyHosts.has(host)) {
      res.redirect(302, upstream);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const upstreamRes = await fetch(upstream, {
        headers: { ...BROWSER_HEADERS, Referer: originOf(upstream) },
        signal: controller.signal,
      });

      // Success → stream the bytes from this origin.
      if (upstreamRes.ok && upstreamRes.body) {
        res.setHeader(
          "Content-Type",
          upstreamRes.headers.get("content-type") ?? "image/jpeg",
        );
        const len = upstreamRes.headers.get("content-length");
        if (len) res.setHeader("Content-Length", len);
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");

        const buffer = Buffer.from(await upstreamRes.arrayBuffer());
        res.end(buffer);
        return;
      }

      // Refused (WAF/bot block) → remember the host and redirect the browser.
      if (REFUSAL_STATUSES.has(upstreamRes.status) && host) {
        redirectOnlyHosts.add(host);
      }
      res.redirect(302, upstream);
    } catch {
      // Network error / timeout — fall back to a direct browser load rather
      // than failing with a 502.
      if (!res.headersSent) res.redirect(302, upstream);
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin + "/";
  } catch {
    return url;
  }
}
