import { describe, expect, it } from "vitest";
import { parseBatch } from "./telemetry.js";

const batch = (at: unknown) =>
  parseBatch({ installId: "install-1", items: [{ name: "feed_open", at }] });

describe("parseBatch event times", () => {
  it("keeps a plausible client time", () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    expect(batch(at)?.items[0].at).toBe(at);
  });

  it("replaces unparseable or far-off times with now", () => {
    const before = Date.now();
    for (const at of ["not a date", "2099-01-01T00:00:00Z", "1970-01-01T00:00:00Z", 42]) {
      const parsed = Date.parse(batch(at)!.items[0].at);
      expect(parsed, String(at)).toBeGreaterThanOrEqual(before);
      expect(parsed, String(at)).toBeLessThanOrEqual(Date.now());
    }
  });
});
