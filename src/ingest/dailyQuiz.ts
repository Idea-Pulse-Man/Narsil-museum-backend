/**
 * Daily Royal Assessment cron.
 * ---------------------------------------------------------------------------
 * Writes today's shared quiz (UTC) into `daily_quizzes` / `daily_quiz_questions`.
 *
 * Rules:
 *   - Target is 10 questions for the day.
 *   - Rows with source = 'admin' are never deleted or replaced.
 *   - A locked day is left exactly as the admin published it.
 *   - If the day already has 10 or more questions, the run does nothing.
 *
 * Usage:
 *   npm run quiz:daily
 *   npm run quiz:daily -- --dry-run
 *   npm run quiz:daily -- --date=2026-09-24
 *   npm run quiz:daily -- --force     # replace generated rows only
 *
 * Cron: see INGEST.md. Run supabase/daily-quiz.sql once before the first job.
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

const DAILY_COUNT = 10;

const MODES = [
  "what",
  "who",
  "age",
  "where",
  "medium",
  "period",
  "museum",
  "subject",
] as const;

type Mode = (typeof MODES)[number];

const SUBJECTS = [
  "portrait",
  "landscape",
  "cityscape",
  "seascape",
  "still life",
  "religious",
  "mythological",
  "interior",
  "abstract",
  "battle",
  "geometric",
];

const PROMPTS: Record<Mode, string[]> = {
  what: ["What is this work titled?", "Which title belongs to this work?"],
  who: ["Who created this work?", "Which artist made this?"],
  age: ["When was this work made?", "Which date fits this work?"],
  where: ["Where is this work from?", "Which place does this work come from?"],
  medium: ["What medium is this?", "How was this work made?"],
  period: ["Which period does this belong to?", "What period is this work from?"],
  museum: ["Where is this work held?", "Which collection holds this work?"],
  subject: ["What kind of scene is this?", "Which subject fits this work?"],
};

interface ArtRow {
  id: string;
  title: string | null;
  image_url: string | null;
  artist_id: string | null;
  year: string | null;
  period: string | null;
  medium: string | null;
  source: string | null;
  accent: string | null;
  tags: string[] | null;
  empire: string | null;
  hidden: boolean | null;
}

interface ArtistRow {
  id: string;
  name: string | null;
  nationality: string | null;
}

interface BuiltQuestion {
  mode: Mode;
  artwork_id: string;
  image_url: string;
  accent: string | null;
  title: string;
  artist_name: string | null;
  year: string | null;
  prompt: string;
  options: string[];
  correct_index: number;
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const dateArg = args.find((a) => a.startsWith("--date="));

function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

const QUIZ_DATE = dateArg?.slice("--date=".length) || utcDateKey();

function usable(value: string | null | undefined): string {
  const v = value?.trim() ?? "";
  if (!v || v === "—" || /^unknown$/i.test(v)) return "";
  return v;
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function trimOption(value: string, max = 60): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function subjectOf(art: ArtRow): string {
  const hit = (art.tags ?? []).find((t) =>
    SUBJECTS.includes(t.trim().toLowerCase()),
  );
  return hit?.trim() ?? "";
}

function answerFor(
  art: ArtRow,
  mode: Mode,
  artists: Map<string, ArtistRow>,
): string {
  const artist = art.artist_id ? artists.get(art.artist_id) : undefined;
  switch (mode) {
    case "what":
      return usable(art.title);
    case "who":
      return usable(artist?.name);
    case "age":
      return /\d/.test(art.year ?? "") ? usable(art.year) : "";
    case "where":
      return usable(art.empire) || usable(artist?.nationality);
    case "medium":
      return usable(art.medium);
    case "period":
      return usable(art.period);
    case "museum":
      return usable(art.source);
    case "subject":
      return subjectOf(art);
    default:
      return "";
  }
}

function buildOne(
  art: ArtRow,
  pool: ArtRow[],
  artists: Map<string, ArtistRow>,
  rng: () => number,
  usedModes: Set<string>,
): BuiltQuestion | null {
  const modes = shuffle(
    MODES.filter((m) => !usedModes.has(`${art.id}:${m}`)),
    rng,
  );
  for (const mode of modes) {
    const correct = answerFor(art, mode, artists);
    if (!correct) continue;
    const correctKey = correct.toLowerCase();
    const seen = new Set<string>([correctKey]);
    const distractors: string[] = [];
    for (const other of shuffle(pool, rng)) {
      if (other.id === art.id) continue;
      const value = answerFor(other, mode, artists);
      if (!value) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      distractors.push(value);
      if (distractors.length === 3) break;
    }
    if (distractors.length < 3) continue;
    const options = shuffle([correct, ...distractors].map((v) => trimOption(v)), rng);
    const correctIndex = options.indexOf(trimOption(correct));
    if (correctIndex < 0) continue;
    const prompts = PROMPTS[mode];
    const artist = art.artist_id ? artists.get(art.artist_id) : undefined;
    return {
      mode,
      artwork_id: art.id,
      image_url: art.image_url!,
      accent: art.accent,
      title: usable(art.title) || "Untitled",
      artist_name: usable(artist?.name) || null,
      year: usable(art.year) || null,
      prompt: prompts[Math.floor(rng() * prompts.length)]!,
      options,
      correct_index: correctIndex,
    };
  }
  return null;
}

async function loadArtworks(db: SupabaseClient): Promise<ArtRow[]> {
  const page = 400;
  const out: ArtRow[] = [];
  for (let from = 0; from < 1200; from += page) {
    const { data, error } = await db
      .from("artworks")
      .select(
        "id, title, image_url, artist_id, year, period, medium, source, accent, tags, empire, hidden",
      )
      .not("image_url", "is", null)
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ArtRow[];
    out.push(...rows.filter((r) => r.image_url && !r.hidden));
    if (rows.length < page) break;
  }
  return out;
}

async function loadArtists(
  db: SupabaseClient,
  ids: string[],
): Promise<Map<string, ArtistRow>> {
  const map = new Map<string, ArtistRow>();
  for (let i = 0; i < ids.length; i += 80) {
    const slice = ids.slice(i, i + 80);
    const { data, error } = await db
      .from("artists")
      .select("id, name, nationality")
      .in("id", slice);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as ArtistRow[]) map.set(row.id, row);
  }
  return map;
}

async function main(): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(QUIZ_DATE)) {
    throw new Error(`Bad --date value: ${QUIZ_DATE}`);
  }
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new Error("Supabase URL and service role key are required.");
  }
  const db = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: header, error: headerErr } = await db
    .from("daily_quizzes")
    .select("quiz_date, locked")
    .eq("quiz_date", QUIZ_DATE)
    .maybeSingle();
  if (headerErr) throw new Error(headerErr.message);

  if (header?.locked) {
    console.log(`daily quiz ${QUIZ_DATE} is locked by an admin — leaving it.`);
    return;
  }

  const { data: existing, error: existingErr } = await db
    .from("daily_quiz_questions")
    .select("id, position, source")
    .eq("quiz_date", QUIZ_DATE)
    .order("position");
  if (existingErr) throw new Error(existingErr.message);

  const rows = existing ?? [];
  if (FORCE && !DRY_RUN) {
    const generatedIds = rows.filter((r) => r.source === "generated").map((r) => r.id);
    if (generatedIds.length) {
      const { error } = await db
        .from("daily_quiz_questions")
        .delete()
        .in("id", generatedIds);
      if (error) throw new Error(error.message);
      console.log(`removed ${generatedIds.length} generated question(s)`);
    }
  }

  const { data: fresh, error: freshErr } = await db
    .from("daily_quiz_questions")
    .select("id, position, source")
    .eq("quiz_date", QUIZ_DATE);
  if (freshErr) throw new Error(freshErr.message);
  const kept = FORCE && DRY_RUN ? rows.filter((r) => r.source === "admin") : (fresh ?? []);
  const have = kept.length;
  const need = Math.max(0, DAILY_COUNT - have);
  if (need === 0) {
    console.log(`daily quiz ${QUIZ_DATE} already has ${have} question(s) — nothing to add.`);
    return;
  }

  const taken = new Set(kept.map((r) => r.position as number));
  const free: number[] = [];
  for (let p = 1; p <= 12 && free.length < need; p++) {
    if (!taken.has(p)) free.push(p);
  }
  if (free.length === 0) {
    console.log(`daily quiz ${QUIZ_DATE} has no free positions.`);
    return;
  }

  const artworks = await loadArtworks(db);
  if (artworks.length < 8) {
    throw new Error(`Not enough artworks with images (${artworks.length}).`);
  }
  const artistIds = [...new Set(artworks.map((a) => a.artist_id).filter(Boolean))] as string[];
  const artists = await loadArtists(db, artistIds);
  const rng = mulberry32(hashString(`daily:${QUIZ_DATE}`));
  const usedArt = new Set(
    kept
      .map((r) => (r as { artwork_id?: string }).artwork_id)
      .filter(Boolean) as string[],
  );
  // existing select didn't include artwork_id — fetch it so we don't repeat a work
  const { data: usedRows } = await db
    .from("daily_quiz_questions")
    .select("artwork_id")
    .eq("quiz_date", QUIZ_DATE);
  for (const r of usedRows ?? []) {
    if (r.artwork_id) usedArt.add(r.artwork_id as string);
  }

  const built: BuiltQuestion[] = [];
  const usedModes = new Set<string>();
  for (const art of shuffle(artworks, rng)) {
    if (built.length >= free.length) break;
    if (usedArt.has(art.id) || !art.image_url) continue;
    const q = buildOne(art, artworks, artists, rng, usedModes);
    if (!q) continue;
    usedArt.add(art.id);
    usedModes.add(`${art.id}:${q.mode}`);
    built.push(q);
  }

  if (built.length === 0) {
    throw new Error("Could not build any questions from the catalog.");
  }

  console.log(
    `${DRY_RUN ? "dry-run " : ""}daily quiz ${QUIZ_DATE}: adding ${built.length} generated (have ${have}, target ${DAILY_COUNT})`,
  );
  if (DRY_RUN) {
    for (const q of built) console.log(`  ${q.mode}: ${q.prompt} ← ${q.title}`);
    return;
  }

  const { error: upsertErr } = await db.from("daily_quizzes").upsert(
    { quiz_date: QUIZ_DATE, locked: false },
    { onConflict: "quiz_date", ignoreDuplicates: true },
  );
  if (upsertErr) throw new Error(upsertErr.message);

  const payload = built.map((q, i) => ({
    quiz_date: QUIZ_DATE,
    position: free[i],
    source: "generated",
    mode: q.mode,
    artwork_id: q.artwork_id,
    image_url: q.image_url,
    accent: q.accent,
    title: q.title,
    artist_name: q.artist_name,
    year: q.year,
    prompt: q.prompt,
    options: q.options,
    correct_index: q.correct_index,
  }));

  const { error: insertErr } = await db.from("daily_quiz_questions").insert(payload);
  if (insertErr) throw new Error(insertErr.message);
  console.log(`wrote ${payload.length} question(s) for ${QUIZ_DATE}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
