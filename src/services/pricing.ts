/**
 * Server-side canvas pricing — a faithful mirror of the frontend's
 * `museum-app/src/data/shop.ts`, so the amount Stripe charges is always
 * computed here and never trusted from the client. Keep the two in sync.
 *
 * ---------------------------------------------------------------------------
 * How these prices were derived (re-run this math if Printful's rates move)
 * ---------------------------------------------------------------------------
 * Printful catalog product 3 ("Canvas (in)"), US fulfillment, live from
 * `GET https://api.printful.com/products/3` (Sep 2026):
 *
 *   Size          Variant  Print cost   US shipping*   Landed
 *   12″×16″           5      $23.41      $10.39        $33.80
 *   18″×24″           7      $33.66      $10.39        $44.05
 *   24″×36″         825      $52.02      $10.39        $62.41
 *
 *   *Printful's published canvas table puts all three of these sizes in the
 *    same US "medium canvas" bucket ($10.39 first item). There is no
 *    separate shipping line at checkout — postage is absorbed into the list.
 *
 * There is no subscriber discount on canvas. Narsil Pro is digital access
 * (quiz, high-res download); prints are full price for everyone.
 *
 * List prices target ~40%+ gross after Stripe's 2.9% + $0.30:
 *
 *   Size     List    Margin $    Margin %
 *   Small     $59     ~$23.20      ~39%
 *   Medium    $89     ~$42.10      ~47%
 *   Large    $129     ~$62.50      ~48%
 *
 * A deterministic +$0 / +$5 / +$10 per-artwork offset still applies on top
 * of these bases (see `priceFromId`).
 *
 * Caveats (Sep 2026 re-check): the $10.39 shipping is the US first-item rate
 * and is the same for every size — confirm the 24×36 figure against a real
 * order. Checkout only accepts US addresses (services/recipient.ts). Non-US
 * cards still cost Stripe +1.5%. The real Printful charge is logged per order
 * at fulfillment (checkout.ts).
 *
 * Artist originals: the artist's share comes out of the margin above, so it
 * is capped at MAX_ARTIST_SHARE_PCT. At 30% the small canvas still nets
 * Narsil ~$5.50 — any higher and small prints lose money.
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

/** Printful print cost + US first-item shipping per size (table above). */
export const LANDED_COST: Record<CanvasSize, number> = {
  Small: 33.8,
  Medium: 44.05,
  Large: 62.41,
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
