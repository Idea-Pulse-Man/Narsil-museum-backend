/**
 * Helpers shared by the style builders: settings access, catalog fields,
 * option construction, and phrasing.
 */
import type { QuizArt, QuizCatalog } from "../catalog.js";
import { formatYear } from "../catalog.js";
import type { Rng } from "../random.js";
import { pick, shuffle } from "../random.js";
import type {
  AnswerType,
  Crop,
  Difficulty,
  ItemOption,
  QuizItemDraft,
  SettingField,
  StyleSettings,
  Surface,
} from "../types.js";
import { DIFFICULTIES } from "../types.js";

export interface BuildContext {
  catalog: QuizCatalog;
  rng: Rng;
  /** Artworks already used as a question's subject in this run (any style). */
  used: Set<string>;
}

export interface StyleBuilder {
  id: string;
  label: string;
  answerType: AnswerType;
  /** One line for the admin panel. */
  description: string;
  /** Suggested surfaces when the style is first seeded. */
  surfaces: Surface[];
  settings: SettingField[];
  defaults: StyleSettings;
  /** One question, or null when this attempt can't make a valid one. */
  build(ctx: BuildContext, settings: StyleSettings): QuizItemDraft | null;
}

// ── Settings ──────────────────────────────────────────────────────────────

export function num(s: StyleSettings, key: string, fallback: number): number {
  const v = Number(s[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function str(s: StyleSettings, key: string, fallback: string): string {
  const v = s[key];
  return typeof v === "string" && v ? v : fallback;
}

export function bool(s: StyleSettings, key: string, fallback: boolean): boolean {
  const v = s[key];
  return typeof v === "boolean" ? v : fallback;
}

export function list(s: StyleSettings, key: string, fallback: string[]): string[] {
  const v = s[key];
  return Array.isArray(v) && v.length ? v.map(String) : fallback;
}

export const DIFFICULTY_FIELD: SettingField = {
  key: "difficulty",
  label: "Difficulty tag",
  type: "select",
  options: [
    { value: "mixed", label: "Mixed (random)" },
    { value: "apprentice", label: "Apprentice" },
    { value: "scholar", label: "Scholar" },
    { value: "master", label: "Master" },
  ],
};

export function difficultyOf(s: StyleSettings, rng: Rng): Difficulty {
  const v = str(s, "difficulty", "mixed");
  if ((DIFFICULTIES as readonly string[]).includes(v)) return v as Difficulty;
  return pick(DIFFICULTIES, rng) ?? "scholar";
}

// ── Catalog fields ────────────────────────────────────────────────────────

export type Field =
  | "artist"
  | "period"
  | "empire"
  | "medium"
  | "museum"
  | "origin"
  | "title";

export const FIELD_CHOICES: Record<Field, string> = {
  artist: "Artist",
  period: "Period",
  empire: "Empire / civilisation",
  medium: "Medium",
  museum: "Museum",
  origin: "Origin (empire or nationality)",
  title: "Title",
};

export function fieldChoices(fields: Field[]) {
  return fields.map((f) => ({ value: f, label: FIELD_CHOICES[f] }));
}

export function fieldValue(art: QuizArt, field: Field): string {
  switch (field) {
    case "artist":
      return art.artistName;
    case "period":
      return art.period;
    case "empire":
      return art.empire;
    case "medium":
      return art.medium;
    case "museum":
      return art.museum;
    case "origin":
      return art.empire || art.nationality;
    case "title":
      return art.title;
  }
}

export const key = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The phrase after "is" for a field value:
 * "Roman", "from the Baroque period", "by Claude Monet", "oil on canvas".
 */
export function isPhrase(field: Field, value: string): string {
  switch (field) {
    case "empire":
    case "origin":
      return value;
    case "period":
      return /\b(period|era|dynasty|age|century|style)\b/i.test(value)
        ? `from the ${value}`
        : `from the ${value} period`;
    case "artist":
      return `by ${value}`;
    case "medium":
      return value.toLowerCase();
    case "museum":
      return `held at ${value}`;
    case "title":
      return `titled “${value}”`;
  }
}

/** Unused, imaged works with a value for `field`, shuffled. */
export function candidates(
  ctx: BuildContext,
  test: (art: QuizArt) => boolean,
): QuizArt[] {
  return shuffle(
    ctx.catalog.arts.filter((a) => !ctx.used.has(a.id) && test(a)),
    ctx.rng,
  );
}

/** Works grouped by a field value (normalised key), skipping blanks. */
export function groupBy(arts: QuizArt[], field: Field): Map<string, QuizArt[]> {
  const out = new Map<string, QuizArt[]>();
  for (const art of arts) {
    const v = fieldValue(art, field);
    if (!v) continue;
    const k = key(v);
    const bucket = out.get(k);
    if (bucket) bucket.push(art);
    else out.set(k, [art]);
  }
  return out;
}

/**
 * Up to `n` works whose `field` differs from `avoid`, preferring the same
 * category as `like` (so a Roman marble sits next to Greek marbles) and
 * distinct values among themselves.
 */
export function distractorsFor(
  ctx: BuildContext,
  like: QuizArt,
  field: Field,
  avoid: Set<string>,
  n: number,
  exclude: Set<string> = new Set(),
): QuizArt[] {
  const valid = (a: QuizArt) => {
    const v = fieldValue(a, field);
    return Boolean(v) && !avoid.has(key(v)) && !exclude.has(a.id) && a.id !== like.id;
  };
  const sameCat = shuffle(
    ctx.catalog.arts.filter((a) => a.category === like.category && valid(a)),
    ctx.rng,
  );
  const rest = shuffle(
    ctx.catalog.arts.filter((a) => a.category !== like.category && valid(a)),
    ctx.rng,
  );
  const out: QuizArt[] = [];
  const seenValues = new Set<string>();
  // First pass: distinct values. Second pass: fill with repeats if needed.
  for (const pass of [true, false]) {
    for (const art of [...sameCat, ...rest]) {
      if (out.length >= n) break;
      if (out.includes(art)) continue;
      const v = key(fieldValue(art, field));
      if (pass && seenValues.has(v)) continue;
      seenValues.add(v);
      out.push(art);
    }
  }
  return out;
}

/** Up to `n` other works, same category first. */
export function similarWorks(
  ctx: BuildContext,
  like: QuizArt,
  n: number,
  exclude: Set<string> = new Set(),
): QuizArt[] {
  const valid = (a: QuizArt) => a.id !== like.id && !exclude.has(a.id);
  const same = shuffle(
    ctx.catalog.arts.filter((a) => a.category === like.category && valid(a)),
    ctx.rng,
  );
  const rest = shuffle(
    ctx.catalog.arts.filter((a) => a.category !== like.category && valid(a)),
    ctx.rng,
  );
  return [...same, ...rest].slice(0, n);
}

// ── Options + text ────────────────────────────────────────────────────────

export const OPTION_IDS = "abcdefghijklmnop".split("");

export function imageOption(
  art: QuizArt,
  id: string,
  extra: Partial<ItemOption> = {},
): ItemOption {
  return {
    id,
    image_url: art.image,
    artwork_id: art.id,
    accent: art.accent,
    ...extra,
  };
}

/** Short reveal note: "Roman · 120 BC" / "Claude Monet · 1872". */
export function noteFor(art: QuizArt, field?: Field): string {
  const lead = field ? fieldValue(art, field) : "";
  const parts = [lead || art.title, art.year].filter(Boolean);
  return parts.join(" · ");
}

/** "Mona Lisa — Leonardo da Vinci, 1503" */
export function caption(art: QuizArt): string {
  const who = [art.artistName, art.year].filter(Boolean).join(", ");
  return who ? `${art.title || "Untitled"} — ${who}` : art.title || "Untitled";
}

export function trimLabel(value: string, max = 60): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

/** Window of an n×n grid: tile (col, row). See `Crop`. */
export function tileCrop(col: number, row: number, n: number): Crop {
  return { x: col / (n - 1), y: row / (n - 1), scale: n };
}

/** "the 1600s" / "the 500s BC" */
export function centuryLabel(year: number): string {
  if (year < 0) return `the ${Math.ceil(Math.abs(year) / 100) * 100}s BC`;
  return `the ${Math.floor(year / 100) * 100}s`;
}

export { formatYear };
