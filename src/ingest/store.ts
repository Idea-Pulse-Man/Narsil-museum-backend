/**
 * Supabase catalog store for the ingestion job.
 * ---------------------------------------------------------------------------
 * Upserts artworks + artists using the SERVICE ROLE key (bypasses RLS). Keyed
 * on the TEXT `id` (`wc-…` / `aic-…`) so daily reruns update in place instead
 * of duplicating.
 *
 * The upsert payloads deliberately OMIT the trigger-managed counter columns
 * (`like_count`, `save_count`, `follower_count`) and `created_by`, so real user
 * activity is never clobbered when the job re-runs.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Artwork, Artist } from "../types/domain.js";
import { env } from "../config/env.js";
import { chunk } from "../utils/http.js";

const BATCH = 200;

export class SupabaseCatalogStore {
  private readonly client: SupabaseClient;

  constructor(
    url = env.supabase.url,
    serviceRoleKey = env.supabase.serviceRoleKey,
  ) {
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async upsertArtists(artists: Artist[]): Promise<void> {
    const rows = artists.map((a) => ({
      id: a.id,
      name: a.name,
      initials: a.initials,
      profile_type: a.profileType,
      bio: a.bio,
      avatar_url: a.avatar ?? null,
      lifespan: a.lifespan,
      nationality: a.nationality,
      period: a.period,
      style: a.style,
      known_for: a.knownFor,
      accent: a.accent ?? null,
      followers: a.followers,
      likes: a.likes,
      saves: a.saves,
    }));

    for (const batch of chunk(rows, BATCH)) {
      const { error } = await this.client
        .from("artists")
        .upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Supabase artists upsert failed: ${error.message}`);
    }
  }

  async upsertArtworks(artworks: Artwork[]): Promise<void> {
    const rows = artworks.map((a) => ({
      id: a.id,
      title: a.title,
      description: a.description,
      image_url: a.image,
      artist_id: a.artistId,
      category: a.category,
      origin: a.origin,
      year: a.year,
      period: a.period,
      medium: a.medium,
      source: a.source,
      accent: a.accent,
      tags: a.tags,
      empire: a.empire ?? null,
    }));

    for (const batch of chunk(rows, BATCH)) {
      const { error } = await this.client
        .from("artworks")
        .upsert(batch, { onConflict: "id" });
      if (error) throw new Error(`Supabase artworks upsert failed: ${error.message}`);
    }
  }
}
