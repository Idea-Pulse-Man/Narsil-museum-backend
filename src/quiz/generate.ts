/**
 * The question generator: reads the admin's style switches from `quiz_styles`,
 * builds + validates questions, saves them to `quiz_items`, and fills the day's
 * `daily_quiz_items` edition. Used by the cron (`npm run quiz:generate`) and by
 * the admin "Generate now" / "Preview" buttons.
 *
 * Tables: museum-app/supabase/quiz-engine.sql.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../services/supabaseAdmin.js";
import { HttpError } from "../utils/httpError.js";
import { loadQuizCatalog, type QuizCatalog } from "./catalog.js";
import { hashString, mulberry32, shuffle } from "./random.js";
import { STYLE_BY_ID, type StyleBuilder } from "./styles/index.js";
import type { QuizItemDraft, StyleSettings } from "./types.js";
import { fingerprint, validateItem } from "./validate.js";

export interface StyleRow {
  id: string;
  label: string;
  answer_type: string;
  enabled: boolean;
  per_run: number;
  surfaces: string[];
  settings: StyleSettings | null;
  require_review: boolean;
}

export interface BuildResult {
  items: QuizItemDraft[];
  rejected: number;
  /** First few validation problems, for the run log. */
  problems: string[];
}

/** A run older than this is treated as crashed and no longer blocks new runs. */
const STALE_RUN_MS = 30 * 60_000;
/** Build attempts per wanted question before giving up on a style. */
const ATTEMPTS_PER_ITEM = 8;
/** Days a question stays out of the daily edition after it was used. */
const DAILY_REPEAT_DAYS = 60;

export function settingsFor(builder: StyleBuilder, row?: { settings: StyleSettings | null } | null): StyleSettings {
  return { ...builder.defaults, ...(row?.settings ?? {}) };
}

/** Pure: build up to `count` valid, distinct questions for one style. */
export function buildItems(
  builder: StyleBuilder,
  settings: StyleSettings,
  catalog: QuizCatalog,
  count: number,
  seed: string,
  used: Set<string> = new Set(),
): BuildResult {
  const rng = mulberry32(hashString(seed));
  const ctx = { catalog, rng, used };
  const items: QuizItemDraft[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  let rejected = 0;
  for (let i = 0; i < count * ATTEMPTS_PER_ITEM && items.length < count; i++) {
    let item: QuizItemDraft | null = null;
    try {
      item = builder.build(ctx, settings);
    } catch (err) {
      rejected++;
      if (problems.length < 5) problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!item) continue;
    const errors = validateItem(item);
    if (errors.length) {
      rejected++;
      if (problems.length < 5) problems.push(errors.join("; "));
      continue;
    }
    const fp = fingerprint(item);
    if (seen.has(fp)) continue;
    seen.add(fp);
    used.add(item.artwork_ids[0]!);
    items.push(item);
  }
  return { items, rejected, problems };
}

// ── Catalog cache (previews hit this repeatedly) ─────────────────────────

let catalogCache: { at: number; catalog: QuizCatalog } | null = null;

async function catalogFor(db: SupabaseClient, fresh: boolean): Promise<QuizCatalog> {
  if (!fresh && catalogCache && Date.now() - catalogCache.at < 10 * 60_000) {
    return catalogCache.catalog;
  }
  const catalog = await loadQuizCatalog(db);
  catalogCache = { at: Date.now(), catalog };
  return catalog;
}

/**
 * The admin's focus style (every daily + practice question is this style), or
 * null. Null too when the column doesn't exist yet (older SQL).
 */
async function focusStyle(db: SupabaseClient): Promise<string | null> {
  const { data, error } = await db
    .from("quiz_engine_config")
    .select("focus_style")
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;
  const focus = (data as { focus_style?: string | null }).focus_style;
  return focus && /^[a-z0-9_]+$/.test(focus) ? focus : null;
}

/** Explicit ids, else every enabled style plus the focus style (even if off). */
async function loadStyles(db: SupabaseClient, ids?: string[]): Promise<StyleRow[]> {
  let query = db
    .from("quiz_styles")
    .select("id, label, answer_type, enabled, per_run, surfaces, settings, require_review")
    .order("sort_order");
  if (ids?.length) {
    query = query.in("id", ids);
  } else {
    const focus = await focusStyle(db);
    query = focus ? query.or(`enabled.eq.true,id.eq.${focus}`) : query.eq("enabled", true);
  }
  const { data, error } = await query;
  if (error) throw new Error(`quiz_styles: ${error.message} (run supabase/quiz-engine.sql?)`);
  return (data ?? []) as StyleRow[];
}

// ── Preview ───────────────────────────────────────────────────────────────

/** Sample questions for one style with the given settings. Saves nothing. */
export async function previewStyle(
  styleId: string,
  settings: StyleSettings | null,
  count = 3,
): Promise<BuildResult> {
  const builder = STYLE_BY_ID[styleId];
  if (!builder) throw new HttpError(400, `Unknown style "${styleId}".`);
  const catalog = await catalogFor(supabaseAdmin(), false);
  return buildItems(
    builder,
    { ...builder.defaults, ...(settings ?? {}) },
    catalog,
    Math.min(10, Math.max(1, count)),
    `preview:${styleId}:${Date.now()}`,
  );
}

// ── Full run ──────────────────────────────────────────────────────────────

export interface RunOptions {
  trigger: "cron" | "admin";
  /** Only these styles (even if switched off). Default: every enabled style. */
  styleIds?: string[];
  /** Override each style's `per_run`. */
  count?: number;
  /** Also top up the day's daily edition. */
  fillDaily?: boolean;
  /** UTC day for the daily edition (default today). */
  date?: string;
  requestedBy?: string | null;
  /** Build and report, write nothing. */
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface RunSummary {
  runId: string | null;
  created: Record<string, number>;
  rejected: Record<string, number>;
  problems: string[];
  daily: DailyFill | null;
  samples: QuizItemDraft[];
}

export async function runGeneration(opts: RunOptions): Promise<RunSummary> {
  const db = supabaseAdmin();
  const log = opts.log ?? (() => {});
  const summary: RunSummary = {
    runId: null,
    created: {},
    rejected: {},
    problems: [],
    daily: null,
    samples: [],
  };

  if (!opts.dryRun) {
    const since = new Date(Date.now() - STALE_RUN_MS).toISOString();
    const { data: running, error } = await db
      .from("quiz_generation_runs")
      .select("id")
      .eq("status", "running")
      .gte("started_at", since)
      .limit(1);
    if (error) throw new Error(`quiz_generation_runs: ${error.message} (run supabase/quiz-engine.sql?)`);
    if (running?.length) {
      throw new HttpError(409, "A generation run is already in progress — try again in a minute.");
    }
    const { data: run, error: runErr } = await db
      .from("quiz_generation_runs")
      .insert({ trigger: opts.trigger, status: "running", requested_by: opts.requestedBy ?? null })
      .select("id")
      .single();
    if (runErr) throw new Error(runErr.message);
    summary.runId = (run as { id: string }).id;
  }

  try {
    const styles = await loadStyles(db, opts.styleIds);
    if (styles.length === 0) log("no enabled styles — nothing to generate");
    const catalog = await catalogFor(db, true);
    log(`catalog: ${catalog.arts.length} artworks, ${catalog.artistNames.length} artists`);

    const used = new Set<string>();
    for (const style of styles) {
      const builder = STYLE_BY_ID[style.id];
      if (!builder) {
        summary.problems.push(`${style.id}: no builder in this backend version`);
        continue;
      }
      const count = opts.count ?? style.per_run;
      if (count <= 0) continue;
      const result = buildItems(
        builder,
        settingsFor(builder, style),
        catalog,
        count,
        `${style.id}:${Date.now()}:${Math.random()}`,
        used,
      );
      summary.rejected[style.id] = result.rejected;
      summary.problems.push(...result.problems.map((p) => `${style.id}: ${p}`));

      if (opts.dryRun) {
        summary.created[style.id] = result.items.length;
        summary.samples.push(...result.items.slice(0, 2));
        log(`${style.id}: built ${result.items.length}/${count} (rejected ${result.rejected})`);
        continue;
      }

      let saved = 0;
      if (result.items.length) {
        const rows = result.items.map((item) => ({
          ...item,
          explain: item.explain ?? null,
          fingerprint: fingerprint(item),
          status: style.require_review ? "review" : "live",
          source: "generated",
          run_id: summary.runId,
        }));
        const { data, error } = await db
          .from("quiz_items")
          .upsert(rows, { onConflict: "fingerprint", ignoreDuplicates: true })
          .select("id");
        if (error) {
          summary.problems.push(`${style.id}: save failed — ${error.message}`);
        } else {
          saved = data?.length ?? 0;
        }
      }
      summary.created[style.id] = saved;
      log(`${style.id}: saved ${saved}/${count} (rejected ${result.rejected})`);
    }

    if (opts.fillDaily && !opts.dryRun) {
      summary.daily = await fillDailyEdition(db, opts.date);
      log(`daily ${summary.daily.date}: added ${summary.daily.added}, now ${summary.daily.total}`);
    }

    if (summary.runId) {
      await db
        .from("quiz_generation_runs")
        .update({
          status: "done",
          finished_at: new Date().toISOString(),
          created: summary.created,
          rejected: summary.rejected,
          problems: summary.problems.slice(0, 40),
          daily_added: summary.daily?.added ?? 0,
        })
        .eq("id", summary.runId);
    }
    return summary;
  } catch (err) {
    if (summary.runId) {
      await db
        .from("quiz_generation_runs")
        .update({
          status: "failed",
          finished_at: new Date().toISOString(),
          problems: [err instanceof Error ? err.message : String(err)],
        })
        .eq("id", summary.runId);
    }
    throw err;
  }
}

// ── Daily edition ─────────────────────────────────────────────────────────

export interface DailyFill {
  date: string;
  added: number;
  total: number;
}

const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Top up a UTC day's `daily_quiz_items` to the admin's `daily_count`, mixing
 * enabled styles that list the `daily` surface. Questions used in the last
 * 60 days are skipped, and no artwork appears twice in one day.
 */
export async function fillDailyEdition(db: SupabaseClient, date = utcDay()): Promise<DailyFill> {
  const { data: config } = await db
    .from("quiz_engine_config")
    .select("daily_count")
    .eq("id", 1)
    .maybeSingle();
  const target = (config as { daily_count?: number } | null)?.daily_count ?? 10;

  const { data: existing, error: exErr } = await db
    .from("daily_quiz_items")
    .select("position, item_id")
    .eq("quiz_date", date);
  if (exErr) throw new Error(`daily_quiz_items: ${exErr.message}`);
  const have = existing ?? [];
  const need = target - have.length;
  if (need <= 0) return { date, added: 0, total: have.length };

  const { data: styleRows } = await db
    .from("quiz_styles")
    .select("id, surfaces")
    .eq("enabled", true);
  const dailyStyles = ((styleRows ?? []) as { id: string; surfaces: string[] }[])
    .filter((s) => s.surfaces?.includes("daily"))
    .map((s) => s.id);
  if (dailyStyles.length === 0) return { date, added: 0, total: have.length };

  const since = new Date(Date.parse(`${date}T00:00:00Z`) - DAILY_REPEAT_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: recent } = await db
    .from("daily_quiz_items")
    .select("item_id")
    .gte("quiz_date", since);
  const recentIds = new Set(((recent ?? []) as { item_id: string }[]).map((r) => r.item_id));

  const { data: pool, error: poolErr } = await db
    .from("quiz_items")
    .select("id, style, artwork_ids")
    .eq("status", "live")
    .in("style", dailyStyles)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (poolErr) throw new Error(`quiz_items: ${poolErr.message}`);

  const rng = mulberry32(hashString(`daily:${date}`));
  const byStyle = new Map<string, { id: string; artwork_ids: string[] }[]>();
  for (const row of shuffle((pool ?? []) as { id: string; style: string; artwork_ids: string[] }[], rng)) {
    if (recentIds.has(row.id)) continue;
    const list = byStyle.get(row.style) ?? [];
    list.push(row);
    byStyle.set(row.style, list);
  }

  // Round-robin across styles so one style can't fill the whole day.
  const usedArt = new Set<string>();
  const picked: string[] = [];
  const order = shuffle([...byStyle.keys()], rng);
  let progress = true;
  while (picked.length < need && progress) {
    progress = false;
    for (const style of order) {
      if (picked.length >= need) break;
      const list = byStyle.get(style)!;
      const idx = list.findIndex((r) => !r.artwork_ids.some((a) => usedArt.has(a)));
      if (idx < 0) continue;
      const [row] = list.splice(idx, 1);
      row!.artwork_ids.forEach((a) => usedArt.add(a));
      picked.push(row!.id);
      progress = true;
    }
  }

  const taken = new Set(have.map((r) => r.position as number));
  const rows: { quiz_date: string; position: number; item_id: string; source: string }[] = [];
  for (let p = 1; p <= 30 && rows.length < picked.length; p++) {
    if (!taken.has(p)) rows.push({ quiz_date: date, position: p, item_id: picked[rows.length]!, source: "generated" });
  }
  if (rows.length) {
    const { error } = await db.from("daily_quiz_items").insert(rows);
    if (error) throw new Error(`daily_quiz_items insert: ${error.message}`);
  }
  return { date, added: rows.length, total: have.length + rows.length };
}

export async function listRuns(limit = 20) {
  const { data, error } = await supabaseAdmin()
    .from("quiz_generation_runs")
    .select("id, trigger, status, started_at, finished_at, created, rejected, problems, daily_added")
    .order("started_at", { ascending: false })
    .limit(Math.min(100, Math.max(1, limit)));
  if (error) throw new HttpError(500, error.message);
  return data ?? [];
}
