/**
 * Server-side canvas sellability — mirrors the DB trigger and licensed_museums
 * allowlist so checkout rejects payment before a canvas_orders row is created.
 */
import { supabaseAdmin } from "./supabaseAdmin.js";
import { HttpError } from "../utils/httpError.js";
import { isMuseumSourceSellable } from "../museum/museumSource.js";

interface SellabilityRow {
  origin: string;
  for_sale: boolean | null;
  museum_source_id: string | null;
}

export function isCanvasSellable(row: SellabilityRow): boolean {
  if (row.origin === "artist-original") {
    return row.for_sale === true;
  }
  if (row.origin === "public-domain") {
    return isMuseumSourceSellable(row.museum_source_id);
  }
  return false;
}

export async function loadArtworkSellability(
  artworkId: string,
): Promise<SellabilityRow | null> {
  const { data, error } = await supabaseAdmin()
    .from("artworks")
    .select("origin, for_sale, museum_source_id")
    .eq("id", artworkId)
    .maybeSingle();
  if (error) {
    throw new HttpError(502, `Artwork lookup failed: ${error.message}`);
  }
  return (data as SellabilityRow | null) ?? null;
}

/** Throws 404/403 when the artwork cannot be sold as a canvas print. */
export async function assertCanvasSellable(artworkId: string): Promise<void> {
  const row = await loadArtworkSellability(artworkId);
  if (!row) {
    throw new HttpError(404, `No artwork with id "${artworkId}"`);
  }
  if (!isCanvasSellable(row)) {
    throw new HttpError(403, "This artwork is not available as a canvas.");
  }
}
