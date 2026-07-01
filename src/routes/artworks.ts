import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import type { ListResponse, Artwork } from "../types/domain.js";

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
