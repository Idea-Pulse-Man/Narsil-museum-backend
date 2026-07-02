import { Router } from "express";
import { getArtistPhotoUrl } from "../museum/artistPhoto.js";

/**
 * Artist portrait lookup — resolves a Wikidata portrait by name server-side.
 *
 * GET /api/artist-photo?name=Leonardo%20da%20Vinci
 * → { url: "https://commons.wikimedia.org/..." } or { url: null }
 */
export function artistPhotoRoutes(): Router {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
      if (!name) {
        res.status(400).json({
          error: "Bad Request",
          message: "Query parameter `name` is required",
        });
        return;
      }

      const url = await getArtistPhotoUrl(name);
      res.setHeader("Cache-Control", url ? "public, max-age=86400" : "public, max-age=3600");
      res.json({ url });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
