/**
 * IIIF Image API 3.0 URL builder.
 * ---------------------------------------------------------------------------
 * The IIIF Image API defines a canonical request URL:
 *
 *   {scheme}://{server}{/prefix}/{identifier}/{region}/{size}/{rotation}/{quality}.{format}
 *
 * See https://iiif.io/api/image/3.0/#21-image-request-uri-syntax
 *
 * We keep to the conservative, cache-friendly subset used by most institutions:
 *   region   = full          (no cropping)
 *   size     = "{width},"    (scale to a fixed width, preserve aspect ratio)
 *   rotation = 0
 *   quality  = default
 *   format   = jpg
 *
 * `size` also accepts the 3.0 keyword `max` (largest the server will return);
 * both `"843,"` and `"max"` are valid IIIF 3.0 size values, so the same builder
 * serves either need.
 */

export interface IiifImageOptions {
  /** Explicit width in px → size `"{width},"`. Ignored when `full` is true. */
  width?: number;
  /** Use the 3.0 `max` size keyword (largest the server will return). */
  full?: boolean;
  region?: string;
  rotation?: number;
  quality?: string;
  format?: string;
}

export class IiifImageService {
  private baseUrl: string;
  /** When true, the base was pinned via env and won't be overridden by discovery. */
  private readonly pinned: boolean;

  /**
   * @param baseUrl       e.g. "https://www.artic.edu/iiif/2" (no trailing slash)
   * @param defaultWidth  default requested width when none is passed per-call
   * @param pinned        set when the base came from explicit configuration
   */
  constructor(
    baseUrl: string,
    private readonly defaultWidth = 843,
    pinned = true,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.pinned = pinned;
  }

  get base(): string {
    return this.baseUrl;
  }

  /**
   * Adopt a base URL discovered from the museum API (`config.iiif_url`). Only
   * takes effect when the operator didn't pin a base explicitly, so an env
   * override always wins.
   */
  adoptDiscoveredBase(url: string | null | undefined): void {
    if (this.pinned || !url) return;
    this.baseUrl = url.replace(/\/$/, "");
  }

  /**
   * Build a fully-qualified IIIF Image API 3.0 request URL for an image
   * identifier. Returns `null` when there is no identifier (so callers can skip
   * artworks that have no associated image).
   */
  imageUrl(
    identifier: string | null | undefined,
    opts: IiifImageOptions = {},
  ): string | null {
    if (!identifier) return null;

    const region = opts.region ?? "full";
    const size = opts.full
      ? "max"
      : `${Math.round(opts.width ?? this.defaultWidth)},`;
    const rotation = opts.rotation ?? 0;
    const quality = opts.quality ?? "default";
    const format = opts.format ?? "jpg";

    return `${this.baseUrl}/${encodeURIComponent(
      identifier,
    )}/${region}/${size}/${rotation}/${quality}.${format}`;
  }

  /** The IIIF `info.json` image-information document URL for an identifier. */
  infoUrl(identifier: string | null | undefined): string | null {
    if (!identifier) return null;
    return `${this.baseUrl}/${encodeURIComponent(identifier)}/info.json`;
  }
}
