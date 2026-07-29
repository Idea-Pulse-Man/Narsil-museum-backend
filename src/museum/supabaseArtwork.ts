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

/**
 * PostgREST caps every response at its `max-rows` setting (1000 on Supabase by
 * default) and does it SILENTLY — a single `.range(0, 9999)` came back with
 * exactly 1000 rows out of 5930, so five of every six ingested artworks never
 * reached the app. Paging is the only way to read the whole table without
 * depending on a dashboard setting.
 */
const PAGE_SIZE = 1000;
/** Safety valve: stop rather than loop forever if paging ever misbehaves. */
const MAX_ROWS = 200_000;

interface PageResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Read a table in pages until it runs dry. The offset advances by the rows
 * actually RECEIVED, not the page size asked for, so a server whose max-rows is
 * smaller than PAGE_SIZE still pages correctly instead of stopping at the first
 * short page. Callers must supply a stable `.order()`, or Postgres is free to
 * return rows in an order that drops and repeats records across pages.
 */
export async function fetchAllPages<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<PageResult>,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  while (from < MAX_ROWS) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Supabase ${label} fetch failed: ${error.message}`);
    const batch = (data as T[] | null) ?? [];
    if (batch.length === 0) break;
    rows.push(...batch);
    from += batch.length;
  }
  return rows;
}

const ARTWORK_COLUMNS =
  "id, title, description, image_url, source_image_url, image_width, image_height, artist_id, year, period, medium, source, accent, tags, category, origin, empire";

interface ArtworkRow {
  id: string;
  title: string;
  description: string | null;
  image_url: string | null;
  source_image_url: string | null;
  image_width: number | null;
  image_height: number | null;
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
    ...(row.source_image_url ? { sourceImage: row.source_image_url } : {}),
    ...(row.image_width ? { imageWidth: row.image_width } : {}),
    ...(row.image_height ? { imageHeight: row.image_height } : {}),
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
    .select(ARTWORK_COLUMNS)
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

  const rows = await fetchAllPages<ArtworkRow>("artworks", (from, to) =>
    db
      .from("artworks")
      .select(ARTWORK_COLUMNS)
      .not("image_url", "is", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map(mapRow);
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

  const rows = await fetchAllPages<ArtistRow>("artists", (from, to) =>
    db
      .from("artists")
      .select(
        "id, name, initials, profile_type, bio, avatar_url, lifespan, nationality, period, style, known_for, accent, followers, likes, saves",
      )
      .order("id", { ascending: true })
      .range(from, to),
  );
  return rows.map(mapArtistRow);
}
