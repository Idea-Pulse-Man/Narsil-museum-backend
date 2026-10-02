import { describe, expect, it } from "vitest";
import { downloadImageUrl, extForType, slugifyFilename } from "./imageDownload.js";

const BASE = "https://api.example.com";

describe("downloadImageUrl", () => {
  it("sizes our own IIIF proxy by query string", () => {
    expect(downloadImageUrl("/api/image/V0006724?w=800", BASE, 2000)).toBe(
      `${BASE}/api/image/V0006724?w=2000`,
    );
    expect(downloadImageUrl("/api/image/V0006724?w=800", BASE, null)).toBe(
      `${BASE}/api/image/V0006724?full=1`,
    );
  });

  it("rewrites the size segment of a direct IIIF URL", () => {
    const src = "https://iiif.micr.io/abc/full/843,/0/default.jpg";
    expect(downloadImageUrl(src, BASE, 2000)).toBe(
      "https://iiif.micr.io/abc/full/2000,/0/default.jpg",
    );
    expect(downloadImageUrl(src, BASE, null)).toBe(
      "https://iiif.micr.io/abc/full/max/0/default.jpg",
    );
  });

  it("unwraps wsrv.nl so the original is fetched", () => {
    const original = "https://bucket.s3.amazonaws.com/art.jpg";
    const wrapped = `https://wsrv.nl/?url=${encodeURIComponent(original)}&w=400`;
    expect(downloadImageUrl(wrapped, BASE, null)).toBe(original);
  });

  it("routes the free tier of raw S3 images through wsrv.nl", () => {
    const src = "https://bucket.s3.amazonaws.com/art.jpg";
    expect(downloadImageUrl(src, BASE, 2000)).toBe(
      `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=2000&output=jpg&q=85`,
    );
  });
});

describe("filename helpers", () => {
  it("slugifies titles and maps content types", () => {
    expect(slugifyFilename("The Night Watch (1642)")).toBe("the-night-watch-1642");
    expect(slugifyFilename("!!!")).toBe("artwork");
    expect(extForType("image/png")).toBe("png");
    expect(extForType("application/octet-stream")).toBe("jpg");
  });
});
