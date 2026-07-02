/**
 * Common contract for a museum source. A source knows how to talk to one
 * museum's Public API + IIIF image server and produce the app's read model
 * (`CatalogData`). Swapping museums is just swapping the implementation.
 */
import type { Artwork, Artist } from "../types/domain.js";

export interface CatalogData {
  artworks: Artwork[];
  artists: Artist[];
}

export interface MuseumSource {
  fetchCatalog(): Promise<CatalogData>;
}
