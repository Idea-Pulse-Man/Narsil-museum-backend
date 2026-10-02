import { describe, expect, it } from "vitest";
import {
  CANVAS_SIZES,
  LANDED_COST,
  MAX_ARTIST_SHARE_PCT,
  PRICE_OFFSETS,
  priceForSize,
  priceFromId,
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
