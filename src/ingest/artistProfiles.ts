/**
 * Artist profile cron — AWS EC2 companion to the artwork ingest job.
 * ---------------------------------------------------------------------------
 * Builds For You artist story profiles from **museum / IIIF catalog data only**.
 * No Wikipedia / Wikidata.
 *
 *   • Collection titles → artworks already ingested (IIIF / Met / CMA / …)
 *   • Bio text          → museum artist bio + collection titles
 *   • Person photograph → existing museum/catalog `avatar_url` only
 *
 * Rules:
 *   - NO real person photograph on the artist row → no card (`profile_ready=false`).
 *   - Thin / stub museum bios → no card.
 *
 * Usage:
 *   npm run ingest:artists -- --dry-run
 *   npm run ingest:artists
 *   npm run ingest:artists -- --limit=40 --force
 *
 * Cron: see INGEST.md (runs after the artwork / IIIF ingest).
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { isUnresolvablePortraitName } from "../museum/artistPhoto.js";
import {
  composeDetailedArtistBio,
  isMuseumStubBio,
  museumBioIsSufficient,
  PROFILE_READY_MIN_BIO,
  type CollectionWork,
} from "../museum/artistWiki.js";

const PAGE = 200;
const DEFAULT_LIMIT = 40;
const CONCURRENCY = 2;

interface ArtistRow {
  id: string;
  name: string;
  bio: string | null;
  known_for: string | null;
  famous_works: string[] | null;
  avatar_url: string | null;
  lifespan: string | null;
  nationality: string | null;
  period: string | null;
  style: string | null;
  profile_type: string | null;
  profile_ready: boolean | null;
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg
  ? Math.max(1, Number(limitArg.split("=")[1]) || DEFAULT_LIMIT)
  : DEFAULT_LIMIT;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

/** True when the artist row already has a usable person photograph URL. */
function hasMuseumPortrait(avatarUrl: string | null | undefined): boolean {
  const url = (avatarUrl ?? "").trim();
  return !!url && /^https?:\/\//i.test(url);
}

async function loadCollectionWorks(
  client: SupabaseClient,
  artistId: string,
): Promise<CollectionWork[]> {
  const { data, error } = await client
    .from("artworks")
    .select("title, source, year, like_count, featured")
    .eq("artist_id", artistId)
    .not("image_url", "is", null)
    .order("featured", { ascending: false })
    .order("like_count", { ascending: false })
    .limit(8);
  if (error) {
    console.warn(`  (collection works for ${artistId}: ${error.message})`);
    return [];
  }
  return (data ?? [])
    .filter((r) => (r.title ?? "").trim().length > 0)
    .map((r) => ({
      title: String(r.title).trim(),
      source: r.source ? String(r.source) : undefined,
      year: r.year ? String(r.year) : undefined,
    }));
}

function knownForFrom(
  famousWorks: string[],
  existing: string | null,
  style: string | null,
): string {
  if (famousWorks.length > 0) return famousWorks.slice(0, 3).join(", ");
  const known = (existing ?? "").trim();
  if (known && !/^Museum collection$/i.test(known)) return known;
  const s = (style ?? "").trim();
  return s && s !== "—" ? s : known;
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    `Artist profiles (museum/IIIF only)${DRY_RUN ? " (dry-run)" : ""}${FORCE ? " (force)" : ""} limit=${LIMIT}`,
  );

  const candidates: ArtistRow[] = [];
  let from = 0;
  for (;;) {
    let query = client
      .from("artists")
      .select(
        "id, name, bio, known_for, famous_works, avatar_url, lifespan, nationality, period, style, profile_type, profile_ready",
      )
      .eq("profile_type", "historical")
      .order("followers", { ascending: false })
      .order("id")
      .range(from, from + PAGE - 1);

    if (!FORCE) {
      query = query.or("profile_ready.is.null,profile_ready.eq.false");
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ArtistRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      if (isUnresolvablePortraitName(row.name)) continue;
      candidates.push(row);
      if (candidates.length >= LIMIT) break;
    }
    if (candidates.length >= LIMIT || rows.length < PAGE) break;
    from += PAGE;
  }

  console.log(`  candidates=${candidates.length}`);

  let ready = 0;
  let noPhoto = 0;
  let noBio = 0;
  let failed = 0;
  let skipped = 0;

  await mapLimit(candidates, CONCURRENCY, async (row) => {
    try {
      // 1) Person photograph — museum/catalog only. No Wikipedia / Wikidata.
      if (!hasMuseumPortrait(row.avatar_url)) {
        noPhoto++;
        if (!DRY_RUN) {
          await client
            .from("artists")
            .update({ profile_ready: false })
            .eq("id", row.id);
        }
        console.log(`  ✗ no museum photo — skip card: ${row.name}`);
        return;
      }
      const avatarUrl = row.avatar_url!.trim();

      // 2) Collection works from the artwork / IIIF ingest
      const collectionWorks = await loadCollectionWorks(client, row.id);
      await sleep(20);

      if (!museumBioIsSufficient(row.bio, collectionWorks)) {
        noBio++;
        if (!DRY_RUN) {
          await client
            .from("artists")
            .update({
              avatar_url: avatarUrl,
              profile_ready: false,
            })
            .eq("id", row.id);
        }
        console.log(`  ✗ museum bio too thin — skip card: ${row.name}`);
        return;
      }

      const famousWorks =
        (row.famous_works ?? []).filter((w) => w?.trim()).length > 0
          ? (row.famous_works ?? []).map((w) => w.trim()).filter(Boolean)
          : collectionWorks.map((w) => w.title).slice(0, 6);

      const detailedBio = composeDetailedArtistBio({
        museumBio: row.bio ?? "",
        wikiBio: "",
        famousWorks,
        collectionWorks,
        artistName: row.name,
      });

      if (
        detailedBio.length < PROFILE_READY_MIN_BIO ||
        isMuseumStubBio(detailedBio)
      ) {
        skipped++;
        console.log(
          `  ✗ bio too thin (${detailedBio.length}c) — skip card: ${row.name}`,
        );
        if (!DRY_RUN) {
          await client
            .from("artists")
            .update({
              avatar_url: avatarUrl,
              profile_ready: false,
            })
            .eq("id", row.id);
        }
        return;
      }

      const payload = {
        avatar_url: avatarUrl,
        bio: detailedBio,
        known_for: knownForFrom(famousWorks, row.known_for, row.style),
        famous_works: famousWorks,
        profile_ready: true,
      };

      if (DRY_RUN) {
        ready++;
        console.log(
          `  · READY ${row.name}: bio=${detailedBio.length}c works=${famousWorks.slice(0, 3).join(" | ") || "—"} collection=${collectionWorks.length}`,
        );
        return;
      }

      const { error } = await client
        .from("artists")
        .update(payload)
        .eq("id", row.id);
      if (error) throw new Error(error.message);
      ready++;
      console.log(
        `  ✓ ${row.name} (bio ${detailedBio.length}c, ${famousWorks.length} famous, ${collectionWorks.length} in catalog)`,
      );
    } catch (err) {
      failed++;
      console.warn(
        `  ✗ ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  console.log(
    `Done. ready=${ready} noPhoto=${noPhoto} noBio=${noBio} thin=${skipped} failed=${failed}` +
      `${DRY_RUN ? " (dry-run)" : ""}`,
  );
  console.log(
    "Museum/IIIF only — no Wikipedia. Cards require museum photo + rich museum bio.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
