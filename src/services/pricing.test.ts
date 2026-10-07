import { describe, expect, it } from "vitest";
import {
  basePrice,
  CANVAS_SIZES,
  LANDED_COST,
  MAX_ARTIST_SHARE_PCT,
  PRICE_OFFSETS,
  priceForSize,
  priceFromId,
  productAllowed,
  PRODUCTS,
  stripeFee,
  type CanvasSize,
} from "./pricing.js";

const SIZES = Object.keys(CANVAS_SIZES) as CanvasSize[];

describe("canvas pricing", () => {
  it("gives every artwork a stable price on one of the offset steps", () => {
    for (const id of ["met-436535", "wc-a1b2c3", "rijks-SK-A-1505", "cma-129"]) {
      const from = priceFromId(id);
      expect(from).toBe(priceFromId(id));
      expect(PRICE_OFFSETS.map((o) => CANVAS_SIZES.Small.price + o)).toContain(from);
    }
  });

  it("applies the artwork's offset to every size", () => {
    const id = "met-436535";
    const offset = priceFromId(id) - CANVAS_SIZES.Small.price;
    for (const size of SIZES) {
      expect(priceForSize(id, size)).toBe(CANVAS_SIZES[size].price + offset);
    }
  });

  it("computes Stripe's 2.9% + $0.30", () => {
    expect(stripeFee(100)).toBe(3.2);
    expect(stripeFee(59)).toBe(2.01);
  });

  it("never sells a canvas below Printful's bill plus Stripe", () => {
    for (const size of SIZES) {
      const price = CANVAS_SIZES[size].price;
      expect(price - LANDED_COST[size] - stripeFee(price)).toBeGreaterThan(0);
    }
  });

  it("still profits on the smallest canvas after the maximum artist share", () => {
    const price = CANVAS_SIZES.Small.price;
    const artistCut = price * (MAX_ARTIST_SHARE_PCT / 100);
    expect(price - artistCut - LANDED_COST.Small - stripeFee(price)).toBeGreaterThan(0);
  });
});

describe("posters and artist originals", () => {
  it("never sells a poster below Printful's bill plus Stripe", () => {
    for (const size of SIZES) {
      const price = PRODUCTS.poster.sizes[size].price;
      expect(price - PRODUCTS.poster.landedCost[size] - stripeFee(price)).toBeGreaterThan(0);
    }
  });

  it("charges $69 for an artist's own Small canvas and leaves Narsil a profit", () => {
    expect(basePrice("canvas", "Small", "artist-original")).toBe(69);
    expect(basePrice("canvas", "Small", "public-domain")).toBe(59);
    expect(basePrice("canvas", "Medium", "artist-original")).toBe(89);
    const price = 69;
    const net = price * (1 - MAX_ARTIST_SHARE_PCT / 100) - LANDED_COST.Small - stripeFee(price);
    expect(net).toBeGreaterThan(5);
  });

  it("sells artist originals as canvas only", () => {
    expect(productAllowed("canvas", "artist-original")).toBe(true);
    expect(productAllowed("poster", "artist-original")).toBe(false);
    expect(productAllowed("poster", "public-domain")).toBe(true);
  });

  it("applies the same per-artwork offset to posters", () => {
    const id = "met-436535";
    const offset = priceFromId(id) - CANVAS_SIZES.Small.price;
    expect(priceForSize(id, "Large", "poster")).toBe(PRODUCTS.poster.sizes.Large.price + offset);
  });
});
