/**
 * Server-side canvas sellability — mirrors the DB trigger and licensed_museums
 * allowlist so checkout rejects payment before a canvas_orders row is created.
 */
import { supabaseAdmin } from "./supabaseAdmin.js";
import { HttpError } from "../utils/httpError.js";
import type { Artwork } from "../types/domain.js";
import {
  isMuseumSourceSellable,
  museumSourceIdFromArtworkId,
} from "../museum/museumSource.js";

interface SellabilityRow {
  origin: string;
  for_sale: boolean | null;
  museum_source_id: string | null;
  category: string | null;
  medium: string | null;
  title: string | null;
  period: string | null;
  tags: string[] | null;
}

const NON_CANVAS_CATEGORIES = new Set(["sculptures", "pottery"]);

/**
 * Painting / drawing supports. Used to keep still lifes ("Basket of Fruit")
 * when the title names an object.
 */
const PAINTING_MEDIUM_RE =
  /\b(oil(?:\s+painting)?|acrylic|tempera|gouache|watercolou?r|fresco|encaustic|pastel)s?\b|\b(charcoal|graphite|pencil|crayon|chalk|ink|wash|distemper|collage|drawing|sketch)\b.{0,32}\bon\b|\bon (canvas|panel|paper|board|cardboard|linen|silk|wood|copper|vellum|parchment|masonite)\b|\b(ukiyo-?e|hanging scroll|handscroll|album leaf)\b/i;

/**
 * Physical crafts / museum pieces — never sold as canvas, even if the medium
 * mentions silk or ink (kimonos, embroidered mounts, furniture).
 */
const CRAFT_OBJECT_RE =
  /\b(furniture|armchair|necklace|earring|bracelet|brooch|pendant|locket|tiara|diadem|jewel(?:le)?ry|buckle|costumes?|kimono|garment|musical instruments?|arms and armou?r|candlestick|chandelier|andiron|snuffbox|netsuke|inr[oō]|tsuba|casket|sarcophagus|teapot|pitcher|platter|tureen|tankard|parasol|saddle|bridle|stirrup|quilt|embroid(?:ery|ed)|tapestry|carpet|rug|sampler|basketry|wicker|rattan|textiles?|plant fibres?|plant fibers?|ash splints?|plaque|stele|censer|incense burner|coins?|medals?)\b/i;

/**
 * Words that appear both on 3D objects and in still-life / history paintings.
 * Keep only when the medium is clearly paint or drawing.
 */
const DEPICTED_OBJECT_RE =
  /\b(sculpture|statue|bust|figurine|terracotta|ceramic|porcelain|earthenware|stoneware|amphora|vase|vessel|pottery|marble|bronze|alabaster|faience|steatite|relief|carved|carving|basket|fan|mask|bottle|chair|stool|armor|armour|helmet|sword|clock|goblet|chalice|mummy|coffin|mirror)\b|\b(covered\s+)?(pot|jar|bowl|urn|ewer|kylix|krater)\b/i;

/** Flat wall art only — pots, sculpture, and crafts are not canvas merch. */
export function isCanvasPrintSuitable(row: {
  category: string | null;
  medium: string | null;
  title: string | null;
  period?: string | null;
  tags?: string[] | null;
}): boolean {
  if (row.category && NON_CANVAS_CATEGORIES.has(row.category)) return false;
  const medium = row.medium ?? "";
  const identity = [row.title ?? "", row.period ?? "", ...(row.tags ?? [])].join(
    " ",
  );
  if (CRAFT_OBJECT_RE.test(identity) || CRAFT_OBJECT_RE.test(medium)) {
    return false;
  }
  if (DEPICTED_OBJECT_RE.test(identity)) {
    return PAINTING_MEDIUM_RE.test(medium);
  }
  return !DEPICTED_OBJECT_RE.test(medium);
}

/** Whether an ingested museum row should be offered as a canvas print. */
export function forSaleFromIngestedArtwork(artwork: Artwork): boolean {
  if (artwork.origin !== "public-domain") return false;
  if (!isCanvasPrintSuitable(artwork)) return false;
  return isMuseumSourceSellable(museumSourceIdFromArtworkId(artwork.id));
}

export function isCanvasSellable(row: SellabilityRow): boolean {
  if (!isCanvasPrintSuitable(row)) return false;
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
    .select(
      "origin, for_sale, museum_source_id, category, medium, title, period, tags",
    )
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
