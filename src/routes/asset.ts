import { Router } from "express";
import { env } from "../config/env.js";

/**
 * Public S3 asset proxy — same-origin delivery for the app.
 * ---------------------------------------------------------------------------
 * Museum images live in a public S3 bucket without browser CORS headers, so
 * client-side `fetch()` (downloads) and some third-party resizers fail. This
 * route streams objects from the configured public bucket through the backend,
 * which already allows `*.vercel.app` origins.
 *
 * Only keys under the configured artwork prefix are allowed (prevents open-proxy
 * abuse). The optional `w` query param is accepted for API compatibility but
 * images are already stored at ingest width (~843px).
 *
 *   GET /api/asset/artworks/wc-acv5spge.jpg
 *   GET /api/asset/artworks/artists/some-portrait.jpg?w=128
 */

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (compatible; NarsilMuseum/1.0; +https://narsil-app-frontend.vercel.app)",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};

export function assetRoutes(): Router {
  const router = Router();
  const publicBase =
    env.aws.s3PublicBaseUrl ||
    (env.aws.s3Bucket
      ? `https://${env.aws.s3Bucket}.s3.${env.aws.region}.amazonaws.com`
      : "");
  const allowedPrefix = env.aws.s3Prefix;

  router.get("/*", async (req, res) => {
    if (!publicBase) {
      res.status(503).json({
        error: "Service Unavailable",
        message: "S3 public base URL is not configured",
      });
      return;
    }

    const key = req.path.replace(/^\/+/, "");
    if (!key || !key.startsWith(`${allowedPrefix}/`)) {
      res.status(400).json({
        error: "Bad Request",
        message: "Asset key must be under the configured S3 prefix",
      });
      return;
    }

    const upstream = `${publicBase}/${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const upstreamRes = await fetch(upstream, {
        headers: BROWSER_HEADERS,
        signal: controller.signal,
      });

      if (!upstreamRes.ok) {
        res.status(upstreamRes.status).json({
          error: "Upstream Error",
          message: `S3 object fetch failed with ${upstreamRes.status}`,
        });
        return;
      }

      const buffer = Buffer.from(await upstreamRes.arrayBuffer());
      res.setHeader(
        "Content-Type",
        upstreamRes.headers.get("content-type") ?? "image/jpeg",
      );
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.end(buffer);
    } catch {
      if (!res.headersSent) {
        res.status(502).json({
          error: "Bad Gateway",
          message: "Could not fetch asset from storage",
        });
      }
    } finally {
      clearTimeout(timer);
    }
  });

  return router;
}
