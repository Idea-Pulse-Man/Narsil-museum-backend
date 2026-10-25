import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicUrl, isPrivateAddress } from "./outboundUrl.js";
import { openImageResponse } from "./imageDownload.js";

describe("isPrivateAddress", () => {
  it("refuses internal, metadata and reserved addresses", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "255.255.255.255",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:169.254.169.254",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "151.101.1.69", "2606:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("assertPublicUrl", () => {
  it("refuses non-http schemes and private IP literals", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(
      assertPublicUrl("http://169.254.169.254/latest/meta-data/full/max/0/x.jpg"),
    ).rejects.toThrow(/not allowed/);
    await expect(assertPublicUrl("http://[::1]:4000/x.jpg")).rejects.toThrow(/not allowed/);
  });

  it("exempts this backend's own origin", async () => {
    await expect(
      assertPublicUrl("http://localhost:4000/api/image/abc?w=2000", "http://localhost:4000"),
    ).resolves.toBeUndefined();
    await expect(
      assertPublicUrl("http://localhost:4001/x", "http://localhost:4000"),
    ).rejects.toThrow(/not allowed/);
  });
});

describe("openImageResponse", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("re-checks every redirect hop", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(openImageResponse("http://8.8.8.8/art.jpg", 5_000)).rejects.toThrow(
      /not allowed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that isn't an image", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("secret", { headers: { "content-type": "text/plain" } })),
    );
    await expect(openImageResponse("http://8.8.8.8/art.jpg", 5_000)).rejects.toThrow(
      /not an image/,
    );
  });

  it("streams an image from a public host", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("jpeg", { headers: { "content-type": "image/jpeg" } })),
    );
    const { contentType } = await openImageResponse("http://8.8.8.8/art.jpg", 5_000);
    expect(contentType).toBe("image/jpeg");
  });
});
