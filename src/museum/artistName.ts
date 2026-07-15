/**
 * Shared artist-name hygiene for every museum source.
 *
 * Museum "artist" fields are catalogue credit lines, not display names. Real
 * examples that reached the app before this existed: "after Anthony van Dyck"
 * (attribution qualifier), "omgeving van Jacob Cornelisz. van Oostsanen"
 * (Dutch "circle of"), "? Thiery" / "[Lautrimi?]" (uncertainty markers), and
 * "a painting" / "18th century Buvée" (not names at all).
 *
 * `cleanArtistName` reduces a credit line to a displayable person/workshop
 * name, or returns null when nothing plausible survives — callers then fall
 * back to their per-source "Unknown Artist" pool, which the frontend already
 * de-emphasises (no profile lookups, filtered from artist rails).
 */

/**
 * Attribution qualifiers that prefix a name. Works credited this way are
 * grouped under the named master's profile — the right call for a discovery
 * app, even though a copy "after Rembrandt" is not by Rembrandt's hand: the
 * description keeps the full credit line, only the profile grouping changes.
 *
 * Order matters: longer phrases must precede their prefixes ("copy after"
 * before "after", "possibly by" before "possibly") because the regex
 * alternation takes the first match.
 */
const QUALIFIER_PREFIXES = [
  // English
  "copy after",
  "copy of",
  "after",
  "formerly attributed to",
  "attributed to",
  "circle of",
  "follower of",
  "school of",
  "style of",
  "manner of",
  "workshop of",
  "studio of",
  "imitator of",
  "possibly by",
  "probably by",
  "possibly",
  "probably",
  "by or after",
  "by",
  // Dutch (Rijksmuseum)
  "kopie naar",
  "naar",
  "omgeving van",
  "toegeschreven aan",
  "atelier van",
  "navolger van",
  "school van",
  "stijl van",
  "manier van",
  "werkplaats van",
  "mogelijk",
  // French / German
  "d'après",
  "attribué à",
  "école de",
  "entourage de",
  "atelier de",
  "suiveur de",
  "nach",
  "zugeschrieben an",
  "umkreis von",
  "werkstatt von",
  "schule von",
  "nachfolger von",
] as const;

const QUALIFIER_PREFIX_RE = new RegExp(
  `^(?:${QUALIFIER_PREFIXES.join("|")})\\s+`,
  "i",
);

/** Whole "names" that are catalogue phrases or anonymity markers, not people. */
const NON_NAME_RE =
  /^(?:painting|drawing|print|lithograph|etching|engraving|woodcut|photograph|sculpture|watercolou?r|various(?:\s+artists?)?|unknown\b.*|unidentified\b.*|anonymous\b.*|anoniem\b.*|onbekend\b.*)$/i;

/**
 * Reduce a raw catalogue credit line to a displayable artist name, or null
 * when no plausible name survives (caller falls back to "Unknown Artist").
 */
export function cleanArtistName(raw: string | null | undefined): string | null {
  if (!raw) return null;

  let name = raw
    // Bracketed/parenthesised segments are qualifiers, dates, or uncertain
    // readings ("[Lautrimi?]", "(1858-1928)") — never part of the display name.
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    // Stray markers left by truncation or uncertainty: "? Thiery", "[N".
    .replace(/[?¿[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Peel attribution qualifiers, outermost first ("copy after attributed to X").
  for (let i = 0; i < 3; i++) {
    const next = name.replace(QUALIFIER_PREFIX_RE, "").trim();
    if (next === name) break;
    name = next;
  }

  // Leading/trailing separator noise. Trailing dots are kept — they belong to
  // abbreviated names ("Jacob Cornelisz. van Oostsanen", "John Smith Jr.").
  name = name.replace(/^[\s,;:.\-–—]+/, "").replace(/[\s,;:\-–—]+$/, "");

  const letters = name.match(/\p{L}/gu) ?? [];
  if (letters.length < 2) return null;
  if (!/^\p{L}/u.test(name)) return null;
  // "a painting", "an engraving" — an article + lowercase word is a phrase,
  // not a name (notnames like "The Berlin Painter" keep their capitals).
  if (/^(?:a|an|the)\s+\p{Ll}/u.test(name)) return null;
  if (NON_NAME_RE.test(name)) return null;

  return name;
}
