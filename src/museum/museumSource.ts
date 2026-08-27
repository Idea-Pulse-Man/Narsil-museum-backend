/**
 * Maps ingested artwork ids to museum source keys and the legal sell allowlist.
 */
import type { Artwork } from "../types/domain.js";

/** First segment of artwork id → `licensed_museums.id`. */
export const ID_PREFIX_TO_SOURCE: Record<string, string> = {
  met: "met",
  rijks: "rijks",
  aic: "artic",
  cma: "cma",
  wc: "wellcome",
  flickr: "flickr",
};

/** Museums the client has cleared for canvas merchandising. */
export const SELLABLE_MUSEUM_SOURCES = new Set([
  "met",
  "rijks",
  "artic",
  "cma",
  "smithsonian",
  "getty",
  "nga",
  "parismusees",
  "mia",
]);

export function museumSourceIdFromArtworkId(artworkId: string): string | null {
  const prefix = artworkId.split("-")[0];
  return ID_PREFIX_TO_SOURCE[prefix] ?? null;
}

export function isMuseumSourceSellable(sourceId: string | null): boolean {
  return sourceId !== null && SELLABLE_MUSEUM_SOURCES.has(sourceId);
}

/** Whether an ingested museum row should be offered as a canvas print. */
export function forSaleFromIngestedArtwork(artwork: Artwork): boolean {
  if (artwork.origin !== "public-domain") return false;
  return isMuseumSourceSellable(museumSourceIdFromArtworkId(artwork.id));
}
