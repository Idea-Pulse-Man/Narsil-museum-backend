/**
 * Server-side canvas pricing — a faithful mirror of the frontend's
 * `museum-app/src/data/shop.ts`, so the amount Stripe charges is always
 * computed here and never trusted from the client. Keep the two in sync.
 *
 * ---------------------------------------------------------------------------
 * How these prices were derived (re-run this math if Printful's rates move)
 * ---------------------------------------------------------------------------
 * Printful catalog product 3 ("Canvas (in)"), US fulfillment, fetched from
 * `GET https://api.printful.com/products/3`:
 *
 *   Size          Variant  Print cost   Shipping*   Landed
 *   12″×16″           5      $23.41      ~$9.95     ~$33.36
 *   18″×24″           7      $33.66     ~$12.95     ~$46.61
 *   24″×36″         825      $52.02     ~$19.95     ~$71.97
 *
 *   *Shipping is an estimate from Printful's published US canvas rates and is
 *    the ONE number here not read from their API. Confirm it against a real
 *    order before treating these margins as exact.
 *
 * There is no separate shipping line at checkout — postage is absorbed into
 * these prices deliberately (the customer sees one number, no shipping shock).
 *
 * Prices are set so that the SUBSCRIBER price — i.e. after
 * SUBSCRIBER_DISCOUNT_PCT — still clears ~36% gross margin net of Stripe's
 * 2.9% + $0.30. Pricing down from list would leave the small canvas at ~$12.
 *
 *   Size     List   Subscriber   Margin (sub)   Margin (list)
 *   Small     $69      $55.20      $19.94  36%    $33.34  48%
 *   Medium    $99      $79.20      $29.99  38%    $49.22  50%
 *   Large    $149     $119.20      $43.47  36%    $72.41  49%
 *
 * Only Small moved (was $59, which left ~$12 once discounted). Medium and
 * Large were already correctly priced against real Printful costs.
 */

export type CanvasSize = "Small" | "Medium" | "Large";

export const CANVAS_SIZES: Record<
  CanvasSize,
  { dimensions: string; price: number }
> = {
  Small: { dimensions: '12 × 16"', price: 69 },
  Medium: { dimensions: '18 × 24"', price: 99 },
  Large: { dimensions: '24 × 36"', price: 149 },
};

/** Narsil Pro discount applied to canvas orders for active subscribers. */
export const SUBSCRIBER_DISCOUNT_PCT = 20;

export function isCanvasSize(value: string): value is CanvasSize {
  return value in CANVAS_SIZES;
}

/** Round to whole cents — prices are charged as `Math.round(price * 100)`. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
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

/**
 * Apply the Narsil Pro discount to a list price.
 *
 * Callers must keep the undiscounted price around: the artist revenue split is
 * computed from the LIST price, so a subscriber's discount comes out of the
 * platform's cut and never out of the artist's (see services/checkout.ts).
 */
export function subscriberPrice(listPrice: number): number {
  return round2(listPrice * (1 - SUBSCRIBER_DISCOUNT_PCT / 100));
}
