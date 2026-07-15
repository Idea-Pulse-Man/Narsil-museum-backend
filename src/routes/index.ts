import { Router } from "express";
import type { CatalogService } from "../museum/catalog.js";
import { artworkRoutes } from "./artworks.js";
import { artistRoutes } from "./artists.js";
import { artistPhotoRoutes } from "./artistPhoto.js";
import { imageRoutes } from "./image.js";
import { checkoutRoutes } from "./checkout.js";
import { printfulWebhookRoutes } from "./printfulWebhook.js";

/** Mounts all `/api/*` routes onto a single router. */
export function apiRoutes(catalog: CatalogService): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Manual cache refresh (handy in dev; harmless in prod).
  router.post("/refresh", (_req, res) => {
    catalog.refresh();
    res.json({ status: "refreshing" });
  });

  router.use("/artworks", artworkRoutes(catalog));
  router.use("/artists", artistRoutes(catalog));
  router.use("/artist-photo", artistPhotoRoutes());
  router.use("/image", imageRoutes(catalog.iiif));
  router.use("/checkout", checkoutRoutes(catalog));
  router.use("/printful", printfulWebhookRoutes());

  return router;
}
