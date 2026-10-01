import { Router } from "express";
import { CANVAS_SIZES, PRICE_OFFSETS, type CanvasSize } from "../services/pricing.js";

/**
 * GET /api/prices — the canvas price table the app displays. Public, and the
 * same numbers checkout charges (services/pricing.ts), so the size picker can
 * never show a different price than the one the customer pays.
 *
 * → { sizes: [{ size, dimensions, price }], offsets: [0, 5, 10] }
 */
export function priceRoutes(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const sizes = (Object.keys(CANVAS_SIZES) as CanvasSize[]).map((size) => ({
      size,
      dimensions: CANVAS_SIZES[size].dimensions,
      price: CANVAS_SIZES[size].price,
    }));
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({ sizes, offsets: PRICE_OFFSETS });
  });

  return router;
}
