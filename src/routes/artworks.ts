import { Router } from "express";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { CatalogService } from "../museum/catalog.js";
import type { ListResponse, Artwork } from "../types/domain.js";
import { getArtworkFromSupabase } from "../museum/supabaseArtwork.js";
import { env } from "../config/env.js";
import { maybeUser, optionalUser } from "../middleware/auth.js";
import { isSubscriber } from "../services/subscriptions.js";
import {
  downloadImageUrl,
  extForType,
  openImageResponse,
  slugifyFilename,
  STANDARD_DOWNLOAD_WIDTH,
} from "../utils/imageDownload.js";

/**
 * Artwork routes. The list endpoint returns the `{ data, total }` envelope the
 * museum-app client (`museum-app/src/lib/api.ts`) expects.
 */
export function artworkRoutes(catalog: CatalogService): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const artworks = await catalog.listArtworks();
      const body: ListResponse<Artwork> = {
        data: artworks,
        total: artworks.length,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Stream the artwork image for download, in one of two tiers:
   *
   *   ?res=standard (default) — 2000px wide, free for everyone
   *   ?res=high               — the museum's largest master, Narsil Pro only
   *
   * Both are genuinely different files: the museum image servers resize on
   * request, so the free tier is a real downscale rather than the same bytes
   * under another name. Entitlement is checked here, server-side.
   *
   * Bytes are piped through (not buffered) so large masters don't sit in
   * process memory twice and time-to-first-byte stays snappy.
   */
  router.get("/:id/download", optionalUser, async (req, res, next) => {
    try {
      const { id } = req.params;
      const wantsHigh = req.query.res === "high";
      const artwork =
        (await catalog.getArtwork(id)) ?? (await getArtworkFromSupabase(id));

      if (!artwork) {
        res.status(404).json({
          error: "Not Found",
          message: `No artwork with id "${id}"`,
        });
        return;
      }

      if (artwork.origin === "artist-original") {
        res.status(403).json({
          error: "Forbidden",
          message: "Download needs the artist's permission",
        });
        return;
      }

      if (!artwork.image) {
        res.status(404).json({
          error: "Not Found",
          message: "This artwork has no image",
        });
        return;
      }

      if (wantsHigh) {
        const user = maybeUser(req);
        if (!user || !(await isSubscriber(user.id))) {
          res.status(402).json({
            error: "Payment Required",
            message: "High-resolution downloads are a Narsil Pro feature.",
          });
          return;
        }
      }

      // Resolve from the museum's own URL — `artwork.image` is the 843px staged
      // copy, so serving it as "high resolution" would be a lie and asking
      // wsrv.nl for 2000px would just upscale it.
      const width = wantsHigh ? null : STANDARD_DOWNLOAD_WIDTH;
      const imageUrl = downloadImageUrl(
        artwork.sourceImage ?? artwork.image,
        env.publicBaseUrl,
        width,
      );
      // High-res masters can be slow to open; standard is usually quick.
      const { response, contentType } = await openImageResponse(
        imageUrl,
        wantsHigh ? 120_000 : 45_000,
      );
      const ext = extForType(contentType);
      const filename =
        `${slugifyFilename(artwork.title)}` +
        `${wantsHigh ? "-hires" : ""}.${ext}`;

      res.setHeader("Content-Type", contentType);
      const len = response.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );

      // Node fetch body → Express response without buffering the whole file.
      await pipeline(
        Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        ),
        res,
      );
    } catch (err) {
      if (!res.headersSent) next(err);
      else res.destroy(err instanceof Error ? err : undefined);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const artwork = await catalog.getArtwork(req.params.id);
      if (!artwork) {
        res.status(404).json({
          error: "Not Found",
          message: `No artwork with id "${req.params.id}"`,
        });
        return;
      }
      res.json(artwork);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
