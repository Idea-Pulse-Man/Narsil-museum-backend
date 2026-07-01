/**
 * Small, dependency-free text helpers used while mapping museum records into
 * the frontend's domain shapes.
 */

/** Strip HTML tags and collapse whitespace/entities into clean prose. */
export function stripHtml(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** URL/id-safe slug, e.g. "Vincent van Gogh" → "vincent-van-gogh". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Two-letter monogram from a name, e.g. "Vincent van Gogh" → "VG". */
export function initialsOf(name: string): string {
  const words = name
    .replace(/[^a-zA-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const first = words[0][0];
  const last = words[words.length - 1][0];
  return (first + last).toUpperCase();
}

/** Deterministic 32-bit hash (FNV-1a) — stable pseudo-values from a seed. */
export function hashString(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic integer in [min, max] derived from a seed. Used to synthesise
 * plausible social-proof numbers (followers/likes/saves) for museum artists,
 * which the Public API does not provide. Same artist → same numbers every run.
 */
export function seededInt(seed: string, min: number, max: number): number {
  const span = Math.max(1, max - min);
  return min + (hashString(seed) % span);
}

/** First sentence of a block of prose (for a short "known for" line). */
export function firstSentence(text: string, maxLen = 120): string {
  if (!text) return "";
  const match = text.match(/^(.*?[.!?])(\s|$)/);
  const sentence = (match ? match[1] : text).trim();
  return sentence.length > maxLen
    ? sentence.slice(0, maxLen - 1).trimEnd() + "…"
    : sentence;
}

/** De-duplicate (case-insensitively) and cap a list of tag-like strings. */
export function uniqueTags(values: (string | null | undefined)[], limit = 6): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

/** Convert an HSL triple to a `#rrggbb` hex string (for the blur-up accent). */
export function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lN - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
