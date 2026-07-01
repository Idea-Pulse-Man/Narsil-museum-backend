/**
 * Image delivery strategy.
 * ---------------------------------------------------------------------------
 * Every artwork image ultimately comes from an IIIF Image API 3.0 server. How
 * the frontend receives it is configurable:
 *
 *   • "direct" — `artwork.image` is the upstream IIIF 3.0 URL. Cleanest, but
 *     the browser loads it cross-origin, so it depends on the museum's image
 *     server allowing hotlinking / CORS from your app.
 *
 *   • "proxy"  — `artwork.image` points back at THIS backend
 *     (`/api/image/:identifier`), which fetches the IIIF 3.0 image server-side
 *     (with browser-style headers) and streams it. The frontend then loads
 *     every image from one origin — no CORS, hotlink, or ngrok `<img>`
 *     interstitial problems. This is the default.
 */
import type { IiifImageService } from "./iiif.js";

export type ImageDelivery = "direct" | "proxy";

export class ImageResolver {
  constructor(
    private readonly iiif: IiifImageService,
    private readonly delivery: ImageDelivery,
    private readonly publicBaseUrl: string,
  ) {
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, "");
  }

  /** Let the museum API's advertised `config.iiif_url` update the base. */
  onDiscoveredBase(url: string | null | undefined): void {
    this.iiif.adoptDiscoveredBase(url);
  }

  /** The URL the frontend should use as an `<img src>` for this identifier. */
  urlFor(identifier: string | null | undefined): string {
    if (!identifier) return "";
    if (this.delivery === "proxy") {
      return `${this.publicBaseUrl}/api/image/${encodeURIComponent(identifier)}`;
    }
    return this.iiif.imageUrl(identifier) ?? "";
  }

  /** The upstream IIIF 3.0 URL for an identifier (used by the proxy route). */
  upstreamUrl(identifier: string | null | undefined): string | null {
    return this.iiif.imageUrl(identifier);
  }
}
