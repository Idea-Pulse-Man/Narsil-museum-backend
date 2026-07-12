/**
 * Reads from Supabase — the merged, ingested catalog (every `MUSEUM_SOURCES`
 * entry lands here via `SupabaseCatalogStore`). This is the app's primary read
 * model: `CatalogService` lists the whole catalog from here, and routes fall
 * back to a single-row read when the in-memory cache doesn't have an id.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Artist, ArtistProfileType, Artwork, ArtworkOrigin } from "../types/domain.js";
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

/** Every ingested artwork, across all `MUSEUM_SOURCES` — the live catalog's artwork list. */
export async function listArtworksFromSupabase(): Promise<Artwork[]> {
  const db = getClient();
  if (!db) {
    throw new Error(
      "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  const { data, error } = await db
    .from("artworks")
    .select(
      "id, title, description, image_url, artist_id, year, period, medium, source, accent, tags, category, origin, empire",
    )
    .not("image_url", "is", null)
    .range(0, 9999);

  if (error) throw new Error(`Supabase artworks fetch failed: ${error.message}`);
  return (data as ArtworkRow[]).map(mapRow);
}

interface ArtistRow {
  id: string;
  name: string;
  initials: string;
  profile_type: string | null;
  bio: string | null;
  avatar_url: string | null;
  lifespan: string | null;
  nationality: string | null;
  period: string | null;
  style: string | null;
  known_for: string | null;
  accent: string | null;
  followers: number | null;
  likes: number | null;
  saves: number | null;
}

function mapArtistRow(row: ArtistRow): Artist {
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    profileType: (row.profile_type as ArtistProfileType) ?? "historical",
    lifespan: row.lifespan ?? "",
    nationality: row.nationality ?? "",
    period: row.period ?? "—",
    style: row.style ?? "—",
    knownFor: row.known_for ?? "",
    bio: row.bio ?? "",
    followers: row.followers ?? 0,
    likes: row.likes ?? 0,
    saves: row.saves ?? 0,
    accent: row.accent ?? undefined,
    avatar: row.avatar_url ?? undefined,
  };
}

/** Every ingested artist, across all `MUSEUM_SOURCES` — the live catalog's artist list. */
export async function listArtistsFromSupabase(): Promise<Artist[]> {
  const db = getClient();
  if (!db) {
    throw new Error(
      "Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  const { data, error } = await db
    .from("artists")
    .select(
      "id, name, initials, profile_type, bio, avatar_url, lifespan, nationality, period, style, known_for, accent, followers, likes, saves",
    )
    .range(0, 9999);

  if (error) throw new Error(`Supabase artists fetch failed: ${error.message}`);
  return (data as ArtistRow[]).map(mapArtistRow);
}
