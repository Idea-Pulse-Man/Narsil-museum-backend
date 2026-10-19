/**
 * The catalog as the question generator sees it: one flat, cleaned record per
 * artwork (artist name resolved, year parsed, placeholders dropped).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface QuizArt {
  id: string;
  title: string;
  artistId: string;
  /** "" when anonymous / generic ("Workshop of…", "Unknown"). */
  artistName: string;
  nationality: string;
  /** Display year as stored ("c. 1650", "120 BC"). */
  year: string;
  /** Parsed year for ordering / sliders (BC is negative), or null. */
  yearNum: number | null;
  period: string;
  medium: string;
  /** Holding museum / source collection. */
  museum: string;
  image: string;
  accent: string;
  tags: string[];
  category: string;
  empire: string;
  /** Museum or AI placard text. */
  description: string;
  likeCount: number;
  /** Scene type from tags (Portrait, Landscape…), or "". */
  subject: string;
}

export interface QuizCatalog {
  arts: QuizArt[];
  byId: Map<string, QuizArt>;
  /** Distinct real artist names, for autocomplete. */
  artistNames: string[];
}

export interface ArtworkRow {
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
  category: string | null;
  empire: string | null;
  hidden: boolean | null;
  description: string | null;
  ai_description: string | null;
  like_count: number | null;
}

export interface ArtistRow {
  id: string;
  name: string | null;
  nationality: string | null;
}

const SUBJECTS = [
  "portrait",
  "self-portrait",
  "landscape",
  "cityscape",
  "seascape",
  "still life",
  "religious",
  "mythological",
  "interior",
  "allegory",
  "abstract",
  "battle",
  "geometric",
  "floral",
  "marine",
];

/** Same patterns as the app's `isGenericMakerName` (feed-utils.ts). */
const GENERIC_MAKER_PATTERNS: RegExp[] = [
  /^\s*(unknown|anonymous|unidentified|various|not known)\b/i,
  /^after\s+/i,
  /\b(workshop|atelier|manufactory|studio of|master of|circle of|follower of|manner of|attributed to|imitator of)\b/i,
  /\bschool\b/i,
  /^an?\s+.*\b(artist|painter|sculptor|engraver|printmaker|illustrator|dra[uf]ghtsman|photographer|architect|designer|potter|goldsmith|ceramicist|muralist|caricaturist|etcher|maker|master|craftsman|calligrapher|scribe)s?\b/i,
];

export function isGenericMakerName(name: string): boolean {
  const key = name.trim();
  if (!key) return true;
  return GENERIC_MAKER_PATTERNS.some((re) => re.test(key));
}

/** Drop empty / placeholder values ("—", "Unknown"). */
export function usable(value: string | null | undefined): string {
  const v = value?.trim() ?? "";
  if (!v || v === "—" || /^unknown$/i.test(v)) return "";
  return v;
}

/**
 * Parse a display year into a number. Handles "1642", "c. 1650–55",
 * "120 BC", "1650s", "17th century" (→ mid-century). Returns null when the
 * label is too messy to compare.
 */
export function parseYear(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const bc = /\b(bc|bce|b\.c\.)\b/i.test(v);
  const nums = [...v.matchAll(/\d{3,4}/g)].map((m) => Number(m[0]));
  if (nums.length > 0) {
    if (bc && nums.length > 1 && nums.some((n) => n > 500)) return null;
    const n = nums[0]!;
    return bc ? -n : n;
  }
  const century = v.match(/(\d{1,2})(st|nd|rd|th)\s+century/i);
  if (century) {
    const c = Number(century[1]);
    const mid = (c - 1) * 100 + 50;
    return bc ? -mid : mid;
  }
  return null;
}

/** "1642" / "120 BC" for a parsed year. */
export function formatYear(year: number): string {
  return year < 0 ? `${Math.abs(year)} BC` : String(year);
}

function subjectOf(tags: string[]): string {
  const hit = tags.find((t) => SUBJECTS.includes(t.trim().toLowerCase()));
  return hit?.trim() ?? "";
}

/** Pure: rows → catalog. Skips hidden works and works without an image. */
export function buildQuizCatalog(
  rows: ArtworkRow[],
  artists: ArtistRow[],
): QuizCatalog {
  const artistById = new Map(artists.map((a) => [a.id, a]));
  const arts: QuizArt[] = [];
  for (const row of rows) {
    if (row.hidden || !row.image_url) continue;
    const artist = row.artist_id ? artistById.get(row.artist_id) : undefined;
    const rawName = usable(artist?.name);
    const year = usable(row.year);
    const museum = usable(row.source);
    const tags = (row.tags ?? []).map((t) => t.trim()).filter(Boolean);
    arts.push({
      id: row.id,
      title: usable(row.title),
      artistId: row.artist_id ?? "",
      artistName: rawName && !isGenericMakerName(rawName) ? rawName : "",
      nationality: usable(artist?.nationality).split("·")[0]?.trim() ?? "",
      year,
      yearNum: /\d/.test(year) ? parseYear(year) : null,
      period: usable(row.period),
      medium: usable(row.medium),
      museum: /^narsil/i.test(museum) ? "" : museum,
      image: row.image_url,
      accent: row.accent?.trim() || "#3a2c1c",
      tags,
      category: row.category ?? "",
      empire: usable(row.empire),
      description: usable(row.ai_description) || usable(row.description),
      likeCount: row.like_count ?? 0,
      subject: subjectOf(tags),
    });
  }
  const artistNames = [
    ...new Set(arts.map((a) => a.artistName).filter(Boolean)),
  ].sort();
  return {
    arts,
    byId: new Map(arts.map((a) => [a.id, a])),
    artistNames,
  };
}

const ARTWORK_COLUMNS =
  "id, title, image_url, artist_id, year, period, medium, source, accent, tags, category, empire, hidden, description, ai_description, like_count";

/** Load every visible artwork + its artists from Supabase. */
export async function loadQuizCatalog(
  db: SupabaseClient,
  maxRows = 6000,
): Promise<QuizCatalog> {
  const page = 1000;
  const rows: ArtworkRow[] = [];
  for (let from = 0; from < maxRows; from += page) {
    const { data, error } = await db
      .from("artworks")
      .select(ARTWORK_COLUMNS)
      .not("image_url", "is", null)
      .or("hidden.is.null,hidden.eq.false")
      .order("id")
      .range(from, from + page - 1);
    if (error) throw new Error(`artworks: ${error.message}`);
    const batch = (data ?? []) as ArtworkRow[];
    rows.push(...batch);
    if (batch.length < page) break;
  }

  const ids = [
    ...new Set(rows.map((r) => r.artist_id).filter(Boolean)),
  ] as string[];
  const artists: ArtistRow[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await db
      .from("artists")
      .select("id, name, nationality")
      .in("id", ids.slice(i, i + 150));
    if (error) throw new Error(`artists: ${error.message}`);
    artists.push(...((data ?? []) as ArtistRow[]));
  }
  return buildQuizCatalog(rows, artists);
}
