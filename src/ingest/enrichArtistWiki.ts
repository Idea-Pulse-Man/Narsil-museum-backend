/**
 * Wikipedia enrichment backfill (legacy thin path).
 * ---------------------------------------------------------------------------
 * Prefer the dedicated artist-profile cron instead:
 *
 *   npm run ingest:artists
 *
 * That job stages the real person photograph to S3, writes a detailed
 * Wikipedia bio + famous works + collection titles, and sets
 * `profile_ready = true` (required for For You artist cards).
 *
 * This script only patches bio / famous_works text and does NOT set
 * profile_ready — keep it for emergency text-only repairs.
 *
 * Usage:
 *   npm run enrich:artist-wiki -- --dry-run
 *   npm run enrich:artist-wiki
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { isUnresolvablePortraitName } from "../museum/artistPhoto.js";
import {
  enrichArtistFromWikipedia,
  isMuseumStubBio,
} from "../museum/artistWiki.js";

const PAGE = 200;
const CONCURRENCY = 2;

interface ArtistRow {
  id: string;
  name: string;
  bio: string | null;
  known_for: string | null;
  famous_works: string[] | null;
  wiki_enriched_at: string | null;
  profile_type: string | null;
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE = args.has("--force");
const limitArg = process.argv.slice(2).find((a) => a.startsWith("--limit="));
const LIMIT = limitArg
  ? Math.max(0, Number(limitArg.split("=")[1]) || 0)
  : Infinity;

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

function knownForFrom(
  description: string,
  famousWorks: string[],
  existing: string | null,
): string {
  if (famousWorks.length > 0) {
    return famousWorks.slice(0, 3).join(", ");
  }
  if (description) return description;
  return (existing ?? "").trim();
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    `Artist Wikipedia enrich${DRY_RUN ? " (dry-run)" : ""}${FORCE ? " (force)" : ""}…`,
  );

  const candidates: ArtistRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("artists")
      .select(
        "id, name, bio, known_for, famous_works, wiki_enriched_at, profile_type",
      )
      .eq("profile_type", "historical")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ArtistRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (isUnresolvablePortraitName(row.name)) continue;
      if (!FORCE && row.wiki_enriched_at) continue;
      // Prefer rows that still have stub bios, or missing famous works.
      const needsCopy =
        FORCE ||
        isMuseumStubBio(row.bio) ||
        !(row.famous_works && row.famous_works.length > 0) ||
        (row.bio ?? "").trim().length < 160;
      if (!needsCopy && !FORCE) continue;
      candidates.push(row);
      if (candidates.length >= LIMIT) break;
    }
    if (candidates.length >= LIMIT || rows.length < PAGE) break;
    from += PAGE;
  }

  console.log(`  candidates=${candidates.length}`);

  let updated = 0;
  let missed = 0;
  let failed = 0;

  await mapLimit(candidates, CONCURRENCY, async (row) => {
    try {
      const wiki = await enrichArtistFromWikipedia(row.name);
      await sleep(200);
      if (!wiki || (!wiki.bio && wiki.famousWorks.length === 0)) {
        missed++;
        return;
      }

      const nextBio =
        wiki.bio.length >= (row.bio ?? "").trim().length || isMuseumStubBio(row.bio)
          ? wiki.bio || row.bio
          : row.bio;
      const nextKnownFor = knownForFrom(
        wiki.description,
        wiki.famousWorks,
        row.known_for,
      );
      const payload = {
        bio: nextBio,
        known_for: nextKnownFor,
        famous_works: wiki.famousWorks,
        wikidata_qid: wiki.qid,
        wikipedia_url: wiki.wikipediaUrl ?? null,
        wiki_enriched_at: new Date().toISOString(),
      };

      if (DRY_RUN) {
        console.log(
          `  · ${row.name}: bio=${(payload.bio ?? "").length}c works=${wiki.famousWorks.slice(0, 3).join(" | ") || "—"}`,
        );
        updated++;
        return;
      }

      const { error } = await client.from("artists").update(payload).eq("id", row.id);
      if (error) throw new Error(error.message);
      updated++;
      if (updated % 25 === 0) console.log(`  …updated ${updated}`);
    } catch (err) {
      failed++;
      console.warn(
        `  ✗ ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  console.log(
    `Done. updated=${updated} missed=${missed} failed=${failed}${DRY_RUN ? " (dry-run)" : ""}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
