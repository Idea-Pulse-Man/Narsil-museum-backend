/**
 * Description backfill — repair existing Supabase rows in place.
 * ---------------------------------------------------------------------------
 * The ingest fixes (wall-text composer, name hygiene, no mid-sentence
 * truncation) only apply to NEW rows. This job re-normalizes what's already
 * live:
 *
 *   Phase A (deterministic, no AI):
 *     - Artist names: re-run `cleanArtistName` — strips stale credit-line
 *       noise like "(eigenhandig gesigneerd)" from rows ingested before the
 *       hygiene existed. Initials are recomputed to match.
 *     - Artwork descriptions: replace field dumps ("Artist · medium · 1858")
 *       and empty text with composed wall-text prose.
 *
 *   Phase B (AI, only when OPENAI_API_KEY is set):
 *     - Rows still thin/boilerplate after Phase A get a generated, validated
 *       `ai_description` (the app prefers it automatically and shows a badge).
 *       Rows that already have one are skipped — never regenerated.
 *
 * Usage:
 *   npm run backfill:descriptions -- --dry-run          # print diffs, write nothing
 *   npm run backfill:descriptions                       # apply Phase A + B
 *   npm run backfill:descriptions -- --ai-limit=100     # cap AI generations this run
 *   npm run backfill:descriptions -- --skip-ai          # Phase A only
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import { cleanArtistName } from "../museum/artistName.js";
import { composeWallText } from "../utils/wallText.js";
import { initialsOf } from "../utils/text.js";
import {
  generateAiDescription,
  shouldGenerateAiDescription,
} from "./aiDescription.js";

const PAGE = 500;
/** Concurrent OpenAI calls — deliberately gentle (Tier-1 account: 500 RPM). */
const AI_CONCURRENCY = 2;

interface ArtworkRow {
  id: string;
  title: string;
  description: string | null;
  ai_description: string | null;
  medium: string | null;
  year: string | null;
  source: string | null;
  tags: string[] | null;
  artist_id: string;
  empire: string | null;
}

interface ArtistRow {
  id: string;
  name: string;
  initials: string | null;
}

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SKIP_AI = args.has("--skip-ai");
const aiLimitArg = process.argv
  .slice(2)
  .find((a) => a.startsWith("--ai-limit="));
const AI_LIMIT = aiLimitArg ? Math.max(0, Number(aiLimitArg.split("=")[1]) || 0) : Infinity;

/** Legacy museum names for rows ingested before `source` was stored. */
function museumOf(row: ArtworkRow): string {
  const source = row.source?.trim();
  if (source) return source;
  if (row.id.startsWith("wc-")) return "Wellcome Collection";
  if (row.id.startsWith("aic-")) return "The Art Institute of Chicago";
  if (row.id.startsWith("met-")) return "The Met";
  if (row.id.startsWith("cma-")) return "The Cleveland Museum of Art";
  if (row.id.startsWith("rijks-")) return "The Rijksmuseum";
  return "";
}

/** A description that merely repeats the metadata grid (or is empty). */
function isDump(description: string): boolean {
  const d = description.trim();
  return d.length === 0 || d.includes(" · ");
}

async function fetchAll<T>(
  // Supabase's query builder is a thenable, not a real Promise — PromiseLike
  // accepts both.
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

/** Run `fn` over `items` with a fixed concurrency limit. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return results;
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY must be set.");
  }
  const client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(
    `Backfill descriptions${DRY_RUN ? " (DRY RUN — nothing will be written)" : ""}`,
  );

  console.log("1/3 Loading catalog rows…");
  const artworks = await fetchAll<ArtworkRow>((from, to) =>
    client
      .from("artworks")
      .select(
        "id, title, description, ai_description, medium, year, source, tags, artist_id, empire",
      )
      .order("id")
      .range(from, to),
  );
  const artists = await fetchAll<ArtistRow>((from, to) =>
    client.from("artists").select("id, name, initials").order("id").range(from, to),
  );
  console.log(`     ${artworks.length} artworks, ${artists.length} artists`);

  // ── Phase A1: artist-name hygiene ─────────────────────────────────────────
  console.log("2/3 Phase A — deterministic repairs…");
  const nameFixes: { id: string; name: string; initials: string }[] = [];
  const artistName = new Map<string, string>();
  for (const artist of artists) {
    const cleaned = cleanArtistName(artist.name) ?? artist.name;
    artistName.set(artist.id, cleaned);
    if (cleaned !== artist.name) {
      nameFixes.push({ id: artist.id, name: cleaned, initials: initialsOf(cleaned) });
    }
  }
  console.log(`     artist names to clean: ${nameFixes.length}`);
  for (const fix of nameFixes.slice(0, 5)) {
    const before = artists.find((a) => a.id === fix.id)?.name;
    console.log(`       "${before}" → "${fix.name}"`);
  }
  if (!DRY_RUN) {
    for (const fix of nameFixes) {
      const { error } = await client
        .from("artists")
        .update({ name: fix.name, initials: fix.initials })
        .eq("id", fix.id);
      if (error) console.warn(`  ✗ artist ${fix.id}: ${error.message}`);
    }
  }

  // ── Phase A2: replace dump descriptions with wall text ────────────────────
  const descFixes: { id: string; description: string }[] = [];
  for (const art of artworks) {
    const current = art.description ?? "";
    if (!isDump(current)) continue;
    const composed = composeWallText({
      artistName: artistName.get(art.artist_id),
      medium: art.medium ?? undefined,
      yearLabel: art.year ?? undefined,
      culture: art.empire ?? undefined,
      museum: museumOf(art),
    });
    if (composed && composed !== current) {
      descFixes.push({ id: art.id, description: composed });
      art.description = composed; // Phase B gates on the repaired text.
    }
  }
  console.log(`     dump descriptions to compose: ${descFixes.length}`);
  for (const fix of descFixes.slice(0, 5)) {
    console.log(`       ${fix.id}: "${fix.description}"`);
  }
  if (!DRY_RUN) {
    for (const fix of descFixes) {
      const { error } = await client
        .from("artworks")
        .update({ description: fix.description })
        .eq("id", fix.id);
      if (error) console.warn(`  ✗ artwork ${fix.id}: ${error.message}`);
    }
  }

  // ── Phase B: AI generation for rows still thin ────────────────────────────
  if (SKIP_AI) {
    console.log("3/3 Phase B skipped (--skip-ai).");
    return;
  }
  if (!env.openai.apiKey) {
    console.log("3/3 Phase B skipped — OPENAI_API_KEY is not set.");
    return;
  }

  const candidates = artworks
    .filter((a) => !a.ai_description)
    .filter((a) => shouldGenerateAiDescription(a.description ?? ""))
    .slice(0, AI_LIMIT === Infinity ? undefined : AI_LIMIT);

  console.log(
    `3/3 Phase B — AI descriptions for ${candidates.length} thin records ` +
      `(model ${env.openai.model})…`,
  );
  if (DRY_RUN) {
    for (const art of candidates.slice(0, 10)) {
      console.log(`       would generate: ${art.id} — "${art.title}"`);
    }
    console.log("     (dry run — no API calls made)");
    return;
  }

  let generated = 0;
  let failed = 0;
  await mapLimit(candidates, AI_CONCURRENCY, async (art) => {
    const text = await generateAiDescription({
      title: art.title,
      artist: artistName.get(art.artist_id) ?? "Unknown Artist",
      medium: art.medium ?? "",
      year: art.year ?? "",
      museum: museumOf(art),
      tags: (art.tags ?? []).slice(0, 6),
      sourceText: art.description ?? undefined,
    });
    if (!text) {
      failed++;
      return;
    }
    const { error } = await client
      .from("artworks")
      .update({ ai_description: text })
      .eq("id", art.id);
    if (error) {
      failed++;
      console.warn(`  ✗ artwork ${art.id}: ${error.message}`);
      return;
    }
    generated++;
    if (generated <= 5) console.log(`       ${art.id}: "${text}"`);
  });

  console.log(`Done — generated=${generated} failed=${failed}.`);
}

main().catch((err) => {
  console.error("Backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
