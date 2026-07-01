import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import type { ListResponse, Artist } from "../types/domain.js";

/**
 * Artist routes. Mirrors the artwork routes' `{ data, total }` envelope so the
 * frontend can fetch artworks and artists with the same tiny client.
 */
export function artistRoutes(catalog: CatalogService): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const artists = await catalog.listArtists();
      const body: ListResponse<Artist> = {
        data: artists,
        total: artists.length,
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:id", async (req, res, next) => {
    try {
      const artist = await catalog.getArtist(req.params.id);
      if (!artist) {
        res.status(404).json({
          error: "Not Found",
          message: `No artist with id "${req.params.id}"`,
        });
        return;
      }
      res.json(artist);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
