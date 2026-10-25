/**
 * Guard for server-side fetches of URLs that came from the database.
 *
 * Artwork image URLs are data, and member uploads write that data. Without a
 * check, a row pointing at `http://169.254.169.254/…` (the EC2 metadata
 * service) or `http://localhost:…` would be fetched by this process and
 * streamed back to whoever asked for the download. Every hop — including each
 * redirect — must resolve to a public address.
 *
 * DNS is resolved here and again by `fetch`, so a host that flips its record
 * between the two (DNS rebinding) is not fully covered; the database guard on
 * member uploads (supabase/integrity-guards.sql) and IMDSv2 on the instance
 * are the other layers.
 */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { HttpError } from "./httpError.js";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast + reserved, through 255.255.255.255
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True for loopback, private, link-local, CGNAT, multicast and reserved IPs. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) — judge the embedded IPv4 address.
    const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all — refuse rather than guess
}

/**
 * Throw unless `url` is http(s) and its host resolves only to public
 * addresses. `trustedOrigin` (this backend's own public URL) is exempt so
 * local development against `http://localhost` keeps working.
 */
export async function assertPublicUrl(url: string, trustedOrigin?: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpError(400, "Image URL is not valid.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, "Image URL must be http(s).");
  }
  if (trustedOrigin) {
    try {
      if (new URL(trustedOrigin).origin === parsed.origin) return;
    } catch {
      /* not a URL — no exemption */
    }
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) {
    throw new HttpError(502, `Image host ${host} could not be resolved.`);
  }
  if (addresses.some(isPrivateAddress)) {
    console.warn(`[outbound] refused ${parsed.origin}: resolves to a private address`);
    throw new HttpError(403, "Image host is not allowed.");
  }
}
