import { Router } from "express";
import {
  ARTIST_ORIGINAL_PRICES,
  CANVAS_SIZES,
  PRICE_OFFSETS,
  PRODUCTS,
  type CanvasSize,
  type ProductType,
} from "../services/pricing.js";

const SIZES = Object.keys(CANVAS_SIZES) as CanvasSize[];

/**
 * GET /api/prices — the print price tables the app displays. Public, and the
 * same numbers checkout charges (services/pricing.ts), so the size picker can
 * never show a different price than the one the customer pays.
 *
 * → {
 *     sizes: [...canvas sizes],          // kept for older app builds
 *     offsets: [0, 5, 10],
 *     products: { canvas: { label, artistOriginals, sizes: [...] }, poster: {...} },
 *     artistOriginal: { canvas: { Small: 69 } }
 *   }
 */
export function priceRoutes(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const sizesOf = (product: ProductType) =>
      SIZES.map((size) => ({
        size,
        dimensions: PRODUCTS[product].sizes[size].dimensions,
        price: PRODUCTS[product].sizes[size].price,
      }));
    const products = Object.fromEntries(
      (Object.keys(PRODUCTS) as ProductType[]).map((product) => [
        product,
        {
          label: PRODUCTS[product].label,
          artistOriginals: PRODUCTS[product].artistOriginals,
          sizes: sizesOf(product),
        },
      ]),
    );
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      sizes: sizesOf("canvas"),
      offsets: PRICE_OFFSETS,
      products,
      artistOriginal: { canvas: ARTIST_ORIGINAL_PRICES },
    });
  });

  return router;
}
