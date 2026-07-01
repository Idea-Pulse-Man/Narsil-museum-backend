/**
 * Maps loose museum metadata (classification, medium, style, place-of-origin,
 * department) onto the frontend's fixed Discover taxonomy: `CategoryId` and the
 * optional ancient `empire` facet. The frontend's `artworkMatchesCategory`
 * matches generously on category + empire + period + tags, so getting the
 * primary `category` roughly right is enough for a coherent browse experience.
 */
import type { CategoryId } from "../types/domain.js";

export interface TaxonomySignals {
  classification?: string | null;
  classifications?: (string | null)[];
  mediumDisplay?: string | null;
  styleTitles?: (string | null)[];
  placeOfOrigin?: string | null;
  departmentTitle?: string | null;
  termTitles?: (string | null)[];
}

function haystackOf(signals: TaxonomySignals): string {
  return [
    signals.classification,
    ...(signals.classifications ?? []),
    signals.mediumDisplay,
    ...(signals.styleTitles ?? []),
    signals.placeOfOrigin,
    signals.departmentTitle,
    ...(signals.termTitles ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Best-effort ancient empire, or undefined for non-antiquity works. */
export function inferEmpire(signals: TaxonomySignals): string | undefined {
  const h = haystackOf(signals);
  if (/egypt/.test(h)) return "Egyptian";
  if (/roman|rome\b|etrusc/.test(h)) return "Roman";
  if (/greek|greece|hellenis|attic|cycladic|minoan/.test(h)) return "Greek";
  if (/japan|ukiyo|edo|nihon/.test(h)) return "Japanese";
  return undefined;
}

/** Best-effort primary browse category. */
export function inferCategory(signals: TaxonomySignals): CategoryId {
  const h = haystackOf(signals);

  // Ancient empires take priority — they are their own Discover cards.
  if (/egypt/.test(h)) return "egyptian";
  if (/roman|rome\b|etrusc/.test(h)) return "roman";
  if (/greek|greece|hellenis|attic|cycladic|minoan/.test(h)) return "greek";

  // Medium-driven categories.
  if (/vessel|ceramic|pottery|porcelain|earthenware|stoneware|terracotta|amphora|vase|jar|bowl/.test(h))
    return "pottery";
  if (/sculpture|statue|bronze|marble|carv|relief|figurine|bust/.test(h))
    return "sculptures";
  if (/print|drawing|etching|engraving|lithograph|woodcut|book|manuscript|letter|calligraphy|folio|page/.test(h))
    return "etching-writing-books";

  // Movement-driven categories.
  if (/japan|ukiyo|edo|nihon/.test(h)) return "japanese-art";
  if (/renaissance|baroque/.test(h)) return "renaissance";
  if (/modern|impression|expression|cubis|surreal|abstract|contemporary|pop art|post-impress/.test(h))
    return "modern-art";

  // Paintings catch the largest remaining bucket.
  if (/paint|oil|tempera|canvas|fresco|watercolor|gouache|acrylic/.test(h))
    return "paintings";

  return "paintings";
}
