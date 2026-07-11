/**
 * Read a single artwork row from Supabase for routes that need the live catalog
 * (e.g. download) when the in-memory museum cache does not have that id.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Artwork, ArtworkOrigin } from "../types/domain.js";
import { env } from "../config/env.js";

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) return null;
  if (!client) {
    client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

interface ArtworkRow {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  artist_id: string | null;
  year: string | null;
  period: string | null;
  medium: string | null;
  source: string | null;
  accent: string | null;
  tags: string[] | null;
  category: string | null;
  origin: string | null;
  empire: string | null;
}

function mapRow(row: ArtworkRow): Artwork {
  return {
    id: row.id,
    title: row.title,
    artistId: row.artist_id ?? "unknown-artist",
    year: row.year ?? "",
    period: row.period ?? "—",
    medium: row.medium ?? "—",
    source: row.source ?? "—",
    image: row.image_url ?? "",
    accent: row.accent ?? "#2a2a2a",
    description: row.description ?? "",
    tags: row.tags ?? [],
    category: (row.category as Artwork["category"]) ?? "paintings",
    origin: (row.origin as ArtworkOrigin) ?? "public-domain",
    ...(row.empire ? { empire: row.empire } : {}),
  };
}

/** Fetch one artwork by id from Supabase, or null when unavailable / not found. */
export async function getArtworkFromSupabase(id: string): Promise<Artwork | null> {
  const db = getClient();
  if (!db) return null;

  const { data, error } = await db
    .from("artworks")
    .select(
      "id, title, description, image_url, artist_id, year, period, medium, source, accent, tags, category, origin, empire",
    )
    .eq("id", id)
    .maybeSingle();

  if (error || !data?.image_url) return null;
  return mapRow(data as ArtworkRow);
}
