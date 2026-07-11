import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import type { ListResponse, Artwork } from "../types/domain.js";
import { getArtworkFromSupabase } from "../museum/supabaseArtwork.js";
import { env } from "../config/env.js";
import {
  extForType,
  fetchImageBytes,
  fullResImageUrl,
  slugifyFilename,
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
   * Stream the artwork image for download. Resolves the image from the in-memory
   * catalog or Supabase, fetches it server-side (avoiding S3 CORS), and returns
   * bytes with Content-Disposition so the browser saves a file.
   */
  router.get("/:id/download", async (req, res, next) => {
    try {
      const { id } = req.params;
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

      const imageUrl = fullResImageUrl(artwork.image, env.publicBaseUrl);
      const { buffer, contentType } = await fetchImageBytes(imageUrl);
      const ext = extForType(contentType);
      const filename = `${slugifyFilename(artwork.title)}.${ext}`;

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.end(buffer);
    } catch (err) {
      next(err);
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
