/**
 * Server-side canvas pricing — a faithful mirror of the frontend's
 * `museum-app/src/data/shop.ts`, so the amount Stripe charges is always
 * computed here and never trusted from the client. Keep the two in sync.
 *
 * ---------------------------------------------------------------------------
 * How these prices were derived (re-run this math if Printful's rates move)
 * ---------------------------------------------------------------------------
 * Printful catalog product 3 ("Canvas (in)"), US fulfillment. Verified
 * 2026-09-28 with Printful's `POST /orders/estimate-costs` to New York and
 * Los Angeles addresses — the same total a real order is billed:
 *
 *   Size      Variant  Print    Ship*    Sales tax**   Printful total
 *   12″×16″       5    $23.41   $10.39   $2.51–3.00    $36.31–36.80
 *   18″×24″       7    $33.66   $10.39   $3.61–3.91    $47.66–47.96
 *   24″×36″     825    $52.02   $10.39   $5.54–5.58    $67.95–67.99
 *
 *   *Same US rate for all three sizes (confirmed). There is no separate
 *    shipping line at checkout — postage is absorbed into the list price.
 *   **Printful charges US sales tax on its bill because the store has no
 *    resale certificate on file.
 *
 * There is no subscriber discount on canvas. Narsil Pro is digital access
 * (quiz, high-res download); prints are full price for everyone.
 *
 * Margin after Printful's full bill and Stripe's 2.9% + $0.30:
 *
 *   Size     List    Profit            Margin
 *   Small     $59    $20.19–20.68      ~34%
 *   Medium    $89    $38.16–38.46      ~43%
 *   Large    $129    $56.97–57.01      ~44%
 *
 * A deterministic +$0 / +$5 / +$10 per-artwork offset still applies on top
 * of these bases (see `priceFromId`).
 *
 * Checkout only accepts US addresses (services/recipient.ts). Non-US cards
 * still cost Stripe +1.5%. The real Printful charge is logged per order at
 * fulfillment (checkout.ts).
 *
 * Artist originals: the artist's share comes out of the margin above, so it
 * is capped at MAX_ARTIST_SHARE_PCT. At 30% the small canvas nets Narsil only
 * ~$2.50 (Medium ~$11.50, Large ~$18.30) — any higher and small prints lose
 * money.
 */

export type CanvasSize = "Small" | "Medium" | "Large";

export const CANVAS_SIZES: Record<
  CanvasSize,
  { dimensions: string; price: number }
> = {
  Small: { dimensions: '12 × 16"', price: 59 },
  Medium: { dimensions: '18 × 24"', price: 89 },
  Large: { dimensions: '24 × 36"', price: 129 },
};

/** Printful's full bill per size — print, shipping and sales tax, highest
 *  of the verified quotes (table above). */
export const LANDED_COST: Record<CanvasSize, number> = {
  Small: 36.8,
  Medium: 47.96,
  Large: 67.99,
};

/** Highest artist revenue share the server will honour, in percent. */
export const MAX_ARTIST_SHARE_PCT = 30;

/** Stripe's standard US card fee on a charge, in currency units. */
export function stripeFee(amount: number): number {
  return Math.round((amount * 0.029 + 0.3) * 100) / 100;
}

export function isCanvasSize(value: string): value is CanvasSize {
  return value in CANVAS_SIZES;
}

/** Deterministic per-artwork "from" price (same hash as the frontend). */
export function priceFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CANVAS_SIZES.Small.price + (h % 3) * 5;
}

/** Final list price in whole currency units for an artwork + size. */
export function priceForSize(artworkId: string, size: CanvasSize): number {
  const offset = priceFromId(artworkId) - CANVAS_SIZES.Small.price;
  return CANVAS_SIZES[size].price + offset;
}
