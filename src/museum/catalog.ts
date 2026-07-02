/**
 * Catalog service — the app's single read model.
 * ---------------------------------------------------------------------------
 * Builds a catalog (artworks + artists) from the configured museum source,
 * caches it with a TTL, and exposes simple lookups the routes need. The source
 * is abstracted behind `ArticSource` so a different museum can be dropped in.
 */
import type { Artwork, Artist } from "../types/domain.js";
import type { Env } from "../config/env.js";
import type { CatalogData, MuseumSource } from "./source.js";
import { ArticSource } from "./artic.js";
import { WellcomeSource } from "./wellcome.js";
import { IiifImageService } from "./iiif.js";
import { ImageResolver } from "./imaging.js";
import { TtlCache } from "../utils/cache.js";

export interface IndexedCatalog extends CatalogData {
  artworkById: Map<string, Artwork>;
  artistById: Map<string, Artist>;
}

export class CatalogService {
  private readonly cache: TtlCache<IndexedCatalog>;
  /** Shared IIIF service — also used by the image-proxy route. */
  readonly iiif: IiifImageService;
  readonly images: ImageResolver;

  constructor(env: Env) {
    this.iiif = new IiifImageService(
      env.iiif.baseUrl,
      env.iiif.imageWidth,
      // Pinned only when the operator actually set a base; otherwise allow the
      // museum API's advertised `config.iiif_url` to take over during ingest.
      Boolean(process.env.IIIF_BASE_URL),
    );

    this.images = new ImageResolver(
      this.iiif,
      env.imageDelivery,
      env.publicBaseUrl,
    );

    const source: MuseumSource =
      env.museum.source === "artic"
        ? new ArticSource(env.museum.apiBaseUrl, this.images, env.museum.catalogLimit)
        : new WellcomeSource(env.museum.apiBaseUrl, this.images, env.museum.catalogLimit);

    this.cache = new TtlCache<IndexedCatalog>(env.museum.cacheTtlMs, async () => {
      const data = await source.fetchCatalog();
      return {
        ...data,
        artworkById: new Map(data.artworks.map((a) => [a.id, a])),
        artistById: new Map(data.artists.map((a) => [a.id, a])),
      };
    });
  }

  private get(): Promise<IndexedCatalog> {
    return this.cache.get();
  }

  async listArtworks(): Promise<Artwork[]> {
    return (await this.get()).artworks;
  }

  async listArtists(): Promise<Artist[]> {
    return (await this.get()).artists;
  }

  async getArtwork(id: string): Promise<Artwork | undefined> {
    return (await this.get()).artworkById.get(id);
  }

  async getArtist(id: string): Promise<Artist | undefined> {
    return (await this.get()).artistById.get(id);
  }

  /** Warm the cache on boot so the first client request is fast. */
  async warm(): Promise<{ artworks: number; artists: number }> {
    const data = await this.get();
    return { artworks: data.artworks.length, artists: data.artists.length };
  }

  /** Force a rebuild on next access. */
  refresh(): void {
    this.cache.clear();
  }
}
