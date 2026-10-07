/**
 * Server-side print pricing — the ONE place prices are set. The amount Stripe
 * charges is always computed here, and the app loads this table from
 * GET /api/prices (routes/prices.ts) for display;
 * `museum-app/src/data/shop.ts` only keeps a copy as an offline fallback.
 *
 * Two products share the same three sizes (12×16, 18×24, 24×36):
 *
 * ---------------------------------------------------------------------------
 * CANVAS — Printful product 3 ("Canvas (in)"). Verified 2026-09-28 with
 * Printful's `POST /orders/estimate-costs` to New York and Los Angeles — the
 * same total a real order is billed:
 *
 *   Size      Variant  Print    Ship*    Sales tax**   Printful total
 *   12″×16″       5    $23.41   $10.39   $2.51–3.00    $36.31–36.80
 *   18″×24″       7    $33.66   $10.39   $3.61–3.91    $47.66–47.96
 *   24″×36″     825    $52.02   $10.39   $5.54–5.58    $67.95–67.99
 *
 *   Size     List    Profit            Margin
 *   Small     $59    $20.19–20.68      ~34%
 *   Medium    $89    $38.16–38.46      ~43%
 *   Large    $129    $56.97–57.01      ~44%
 *
 * ---------------------------------------------------------------------------
 * POSTER — Printful product 1 ("Enhanced Matte Paper Poster (in)"). Print
 * costs are from Printful's public catalog (2026-10-07). Shipping is an
 * ALLOWANCE, not yet verified — re-run the estimate-costs check from EC2
 * (see README → Money rules) and correct `landedCost` if it differs:
 *
 *   Size      Variant  Print    Ship (allow.)  Tax ~9%   Landed (est.)
 *   12″×16″    1349    $10.50   $6.99          $1.57     ~$19.06
 *   18″×24″       1    $12.25   $6.99          $1.73     ~$20.97
 *   24″×36″       2    $16.95   $8.99          $2.33     ~$28.27
 *
 *   Size     List    Profit (est.)   Margin
 *   Small     $29    ~$8.80          ~30%
 *   Medium    $35    ~$12.70         ~36%
 *   Large     $45    ~$15.10         ~34%
 *
 * ---------------------------------------------------------------------------
 *   *Shipping is absorbed into the list price — no shipping line at checkout.
 *   **Printful charges US sales tax because the store has no resale
 *    certificate on file.
 *
 * No subscriber discount on prints. A deterministic +$0 / +$5 / +$10
 * per-artwork offset applies on top of every base (see `priceFromId`).
 * Checkout only accepts US addresses (services/recipient.ts). The real
 * Printful charge is logged per order at fulfillment (checkout.ts).
 *
 * Artist originals: sold as canvas only (a poster can't carry the artist's
 * 30% share and still profit). Their Small canvas is $69 instead of $59 — at
 * $59 the artist's share left Narsil ~$2.50; at $69 it leaves ~$9.
 */

export type CanvasSize = "Small" | "Medium" | "Large";
export type ProductType = "canvas" | "poster";

interface ProductSpec {
  label: string;
  sizes: Record<CanvasSize, { dimensions: string; price: number }>;
  /** Printful's full bill per size: print + shipping + sales tax. */
  landedCost: Record<CanvasSize, number>;
  /** Whether an artist's own uploads can be ordered as this product. */
  artistOriginals: boolean;
}

export const PRODUCTS: Record<ProductType, ProductSpec> = {
  canvas: {
    label: "Canvas",
    sizes: {
      Small: { dimensions: '12 × 16"', price: 59 },
      Medium: { dimensions: '18 × 24"', price: 89 },
      Large: { dimensions: '24 × 36"', price: 129 },
    },
    landedCost: { Small: 36.8, Medium: 47.96, Large: 67.99 },
    artistOriginals: true,
  },
  poster: {
    label: "Poster",
    sizes: {
      Small: { dimensions: '12 × 16"', price: 29 },
      Medium: { dimensions: '18 × 24"', price: 35 },
      Large: { dimensions: '24 × 36"', price: 45 },
    },
    landedCost: { Small: 19.06, Medium: 20.97, Large: 28.27 },
    artistOriginals: false,
  },
};

/** Base prices that differ for an artist's own work (canvas only). */
export const ARTIST_ORIGINAL_PRICES: Partial<Record<CanvasSize, number>> = {
  Small: 69,
};

/** Canvas sizes — kept for code that predates posters. */
export const CANVAS_SIZES = PRODUCTS.canvas.sizes;
/** Canvas landed cost — kept for code that predates posters. */
export const LANDED_COST = PRODUCTS.canvas.landedCost;

/** Highest artist revenue share the server will honour, in percent. */
export const MAX_ARTIST_SHARE_PCT = 30;

/** Stripe's standard US card fee on a charge, in currency units. */
export function stripeFee(amount: number): number {
  return Math.round((amount * 0.029 + 0.3) * 100) / 100;
}

export function isCanvasSize(value: string): value is CanvasSize {
  return value in CANVAS_SIZES;
}

export function isProductType(value: string): value is ProductType {
  return value in PRODUCTS;
}

/** Whether this product can be ordered for an artwork of this origin. */
export function productAllowed(product: ProductType, origin?: string): boolean {
  return origin !== "artist-original" || PRODUCTS[product].artistOriginals;
}

/** Per-artwork price steps added on top of every size's base price. */
export const PRICE_OFFSETS = [0, 5, 10];

function offsetFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PRICE_OFFSETS[h % PRICE_OFFSETS.length];
}

/** Base price for a product + size, before the per-artwork offset. */
export function basePrice(
  product: ProductType,
  size: CanvasSize,
  origin?: string,
): number {
  if (origin === "artist-original" && product === "canvas") {
    const special = ARTIST_ORIGINAL_PRICES[size];
    if (special) return special;
  }
  return PRODUCTS[product].sizes[size].price;
}

/**
 * Deterministic per-artwork "from" price (the Small size). The app reads
 * these tables from GET /api/prices and runs the same hash, so the prices it
 * shows always come from this file.
 */
export function priceFromId(
  id: string,
  product: ProductType = "canvas",
  origin?: string,
): number {
  return basePrice(product, "Small", origin) + offsetFor(id);
}

/** Final list price in whole currency units for an artwork, size and product. */
export function priceForSize(
  artworkId: string,
  size: CanvasSize,
  product: ProductType = "canvas",
  origin?: string,
): number {
  return basePrice(product, size, origin) + offsetFor(artworkId);
}
