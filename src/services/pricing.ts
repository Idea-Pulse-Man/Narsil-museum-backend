/**
 * Server-side canvas pricing — a faithful mirror of the frontend's
 * `museum-app/src/data/shop.ts`, so the amount Stripe charges is always
 * computed here and never trusted from the client. Keep the two in sync.
 */

export type CanvasSize = "Small" | "Medium" | "Large";

export const CANVAS_SIZES: Record<
  CanvasSize,
  { dimensions: string; price: number }
> = {
  Small: { dimensions: '12 × 16"', price: 59 },
  Medium: { dimensions: '18 × 24"', price: 99 },
  Large: { dimensions: '24 × 36"', price: 149 },
};

export function isCanvasSize(value: string): value is CanvasSize {
  return value in CANVAS_SIZES;
}

/** Deterministic per-artwork "from" price (same hash as the frontend). */
export function priceFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CANVAS_SIZES.Small.price + (h % 3) * 5;
}

/** Final price in whole currency units for an artwork + size. */
export function priceForSize(artworkId: string, size: CanvasSize): number {
  const offset = priceFromId(artworkId) - CANVAS_SIZES.Small.price;
  return CANVAS_SIZES[size].price + offset;
}
