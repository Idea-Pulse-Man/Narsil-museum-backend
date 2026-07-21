/**
 * Deterministic museum wall-text composer.
 *
 * When a record has no real prose, sources used to fall back to a raw field
 * dump ("Artist · medium · 1858") that just repeats the placard's metadata
 * grid. This composes the same facts into placard-style sentences instead —
 * the pattern the Met adapter proved out — so every artwork has readable
 * prose without inventing anything.
 */

export interface WallTextInput {
  /** Display artist name; "Unknown Artist" is treated as absent. */
  artistName?: string;
  /** Human medium line, e.g. "oil on canvas". Placeholder "—" is ignored. */
  medium?: string;
  /** Year label, e.g. "1858" / "ca. 1815". "Date unknown" is ignored. */
  yearLabel?: string;
  /** Object type when medium is missing, e.g. "painting". */
  typeLabel?: string;
  /** Culture / place of production, e.g. "Dutch", "Edo Japan". */
  culture?: string;
  /** Holding institution, e.g. "The Rijksmuseum, Amsterdam". */
  museum?: string;
}

const present = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t && t !== "—" && t !== "Date unknown" ? t : undefined;
};

/**
 * Drop parenthetical vocabulary qualifiers that repeat a word already present
 * — "paint on canvas, oil paint (paint)" → "paint on canvas, oil paint".
 */
function tidyMedium(medium: string): string {
  return medium
    .replace(/\s*\(([^)]*)\)/g, (full, inner: string) => {
      const outside = medium.replace(full, "").toLowerCase();
      return outside.includes(inner.trim().toLowerCase()) ? "" : full;
    })
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .trim();
}

/**
 * Compose placard prose from catalog fields. Returns "" when there is nothing
 * beyond a bare title to say (caller decides its own last-resort line).
 *
 *   "Oil on canvas by Prosper Crébassol, 1858. The Rijksmuseum, Amsterdam."
 */
export function composeWallText(input: WallTextInput): string {
  const artist =
    input.artistName && input.artistName !== "Unknown Artist"
      ? input.artistName.trim()
      : undefined;
  const rawMedium = present(input.medium) ?? present(input.typeLabel);
  const medium = rawMedium ? tidyMedium(rawMedium) : undefined;
  const year = present(input.yearLabel);
  const culture = present(input.culture);
  const museum = present(input.museum);

  let lead = medium ?? "";
  if (lead) lead = lead.charAt(0).toUpperCase() + lead.slice(1);
  if (artist) lead = lead ? `${lead} by ${artist}` : `A work by ${artist}`;
  if (!lead) return "";
  if (year) lead += `, ${year}`;

  const sentences = [`${lead}.`];
  if (culture) sentences.push(`Culture: ${culture}.`);
  if (museum) sentences.push(`${museum}.`);
  return sentences.join(" ");
}
