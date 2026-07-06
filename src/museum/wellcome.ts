/**
 * Wellcome Collection — museum Public API source.
 * ---------------------------------------------------------------------------
 * Docs: https://developers.wellcomecollection.org/docs/catalogue
 *
 * Chosen as the default source because, unlike some museum image servers, the
 * Wellcome IIIF Image API 3.0 server (`iiif.wellcomecollection.org`) serves
 * requests to the backend, so images can be fetched server-side and STREAMED to
 * the frontend from this origin — they always display, regardless of the
 * browser's own network access to the museum.
 *
 * It pulls "Pictures" (paintings, watercolours, engravings, drawings, …) that
 * have a public-domain IIIF image, extracts the title, description/notes,
 * contributor (artist), production dating and genres, and maps them onto the
 * frontend's `Artwork` / `Artist` domain types.
 */
import type { Artwork, Artist } from "../types/domain.js";
import type { ImageResolver } from "./imaging.js";
import type { CatalogData, MuseumSource } from "./source.js";
import { inferCategory, inferEmpire } from "./taxonomy.js";
import { fetchJson } from "../utils/http.js";
import {
  stripHtml,
  slugify,
  initialsOf,
  seededInt,
  uniqueTags,
  hslToHex,
  hashString,
} from "../utils/text.js";

// ── Upstream API shapes (only the fields we request) ──────────────────────

interface WcLabel {
  id?: string;
  label: string;
}

interface WcContributor {
  agent?: { label?: string; type?: string };
  roles?: WcLabel[];
}

interface WcProduction {
  dates?: WcLabel[];
  places?: WcLabel[];
  agents?: WcLabel[];
}

interface WcNote {
  noteType?: WcLabel;
  contents?: string[];
}

interface WcLocation {
  locationType?: { id?: string };
  url?: string;
}

interface WcItem {
  locations?: WcLocation[];
}

interface WcWork {
  id: string;
  title?: string;
  description?: string;
  physicalDescription?: string;
  workType?: WcLabel;
  contributors?: WcContributor[];
  production?: WcProduction[];
  genres?: WcLabel[];
  subjects?: WcLabel[];
  notes?: WcNote[];
  items?: WcItem[];
  thumbnail?: { url?: string };
}

interface WcResultList<T> {
  totalResults?: number;
  totalPages?: number;
  pageSize?: number;
  results?: T[];
}

const INCLUDES = [
  "production",
  "contributors",
  "subjects",
  "genres",
  "items",
  "notes",
].join(",");

const PAGE_SIZE = 100;
/** Hard cap on pages fetched in one run, so a huge limit can't hammer the API. */
const MAX_PAGE_CAP = 200;

export class WellcomeSource implements MuseumSource {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly images: ImageResolver,
    private readonly limit: number,
  ) {}

  async fetchCatalog(): Promise<CatalogData> {
    const works = await this.collectWorks();
    return this.mapCatalog(works);
  }

  // ── Ingestion ───────────────────────────────────────────────────────────

  /**
   * Page through "Pictures" that have an IIIF image, ranked by how likely the
   * artist is to be an identifiable person (and therefore resolve a real photo
   * in the frontend):
   *   1. an authority-controlled Person contributor (e.g. "Turner, J. M. W."),
   *   2. any other named contributor / a name parsed from the title,
   *   3. anonymous works — used only to top the feed up to `limit`.
   * Keeping tier 1 first maximises the number of avatars that get a Wikipedia
   * portrait rather than an initials monogram.
   */
  private async collectWorks(): Promise<WcWork[]> {
    const person: WcWork[] = [];
    const named: WcWork[] = [];
    const anonymous: WcWork[] = [];

    // Page deep enough to satisfy the requested limit (plus headroom for the
    // works we filter out), capped so a big limit can't hammer the API.
    const maxPages = Math.min(
      MAX_PAGE_CAP,
      Math.max(1, Math.ceil(this.limit / PAGE_SIZE) + 4),
    );

    for (let page = 1; page <= maxPages; page++) {
      const url =
        `${this.apiBaseUrl}/works` +
        `?pageSize=${PAGE_SIZE}&page=${page}` +
        `&workType=k` +
        `&items.locations.locationType=iiif-image` +
        `&include=${encodeURIComponent(INCLUDES)}`;

      const res = await fetchJson<WcResultList<WcWork>>(url);
      const results = res.results ?? [];
      if (results.length === 0) break;

      for (const work of results) {
        if (!this.identifierOf(work)) continue;
        if (this.personLabelOf(work)) person.push(work);
        else if (this.artistNameOf(work)) named.push(work);
        else anonymous.push(work);
      }

      // Stop once we have enough candidates across all tiers.
      if (person.length + named.length + anonymous.length >= this.limit) break;

      const totalPages = res.totalPages ?? page;
      if (page >= totalPages) break;
    }

    const out: WcWork[] = [];
    for (const tier of [person, named, anonymous]) {
      for (const work of tier) {
        if (out.length >= this.limit) break;
        out.push(work);
      }
    }
    return out;
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private mapCatalog(works: WcWork[]): CatalogData {
    interface ArtistAccumulator {
      id: string;
      name: string;
      places: string[];
      genres: string[];
      subjects: string[];
      years: number[];
    }

    const artistAcc = new Map<string, ArtistAccumulator>();
    const artworks: Artwork[] = [];

    for (const work of works) {
      const name = this.artistNameOf(work) ?? "Unknown Artist";
      const artistId = this.artistIdOf(name);

      const acc =
        artistAcc.get(artistId) ??
        ({
          id: artistId,
          name,
          places: [],
          genres: [],
          subjects: [],
          years: [],
        } satisfies ArtistAccumulator);

      for (const place of this.placesOf(work)) acc.places.push(place);
      const genre = work.genres?.[0]?.label;
      if (genre) acc.genres.push(genre);
      for (const subject of work.subjects ?? []) acc.subjects.push(subject.label);
      const year = this.startYearOf(work);
      if (year != null) acc.years.push(year);
      artistAcc.set(artistId, acc);

      artworks.push(this.mapArtwork(work, artistId));
    }

    const artists = Array.from(artistAcc.values()).map((acc) => this.buildArtist(acc));
    return { artworks, artists };
  }

  private mapArtwork(work: WcWork, artistId: string): Artwork {
    const identifier = this.identifierOf(work);
    const genres = (work.genres ?? []).map((g) => g.label);
    const subjects = (work.subjects ?? []).map((s) => s.label);
    const medium = this.mediumOf(work);

    const signals = {
      mediumDisplay: medium,
      styleTitles: genres,
      placeOfOrigin: this.placesOf(work).join(" "),
      termTitles: [...genres, ...subjects],
    };

    const empire = inferEmpire(signals);

    return {
      id: `wc-${work.id}`,
      title: this.titleOf(work),
      artistId,
      year: this.yearLabelOf(work),
      period: genres[0] || this.centuryOf(this.startYearOf(work)) || "—",
      medium: medium || "—",
      source: "Wellcome Collection",
      image: this.images.urlFor(identifier),
      accent: this.accentFor(work.id),
      description: this.describe(work),
      tags: uniqueTags([...genres, ...subjects]),
      category: inferCategory(signals),
      origin: "public-domain",
      ...(empire ? { empire } : {}),
    };
  }

  private buildArtist(acc: {
    id: string;
    name: string;
    places: string[];
    genres: string[];
    subjects: string[];
    years: number[];
  }): Artist {
    const nationality = this.mostCommon(acc.places) || "—";
    const style = this.mostCommon(acc.genres) || "—";
    const lifespan = this.centuryOf(this.avg(acc.years)) || "—";

    // Keep the three profile stats semantically distinct rather than echoing
    // the same genre: Period = era, Style = genre/technique, Known for =
    // recurring subjects (falling back to the medium, then a generic label).
    const period = lifespan;
    const topSubjects = this.topCommon(acc.subjects, 2).filter(
      (s) => s.toLowerCase() !== style.toLowerCase(),
    );
    const knownFor =
      topSubjects.length > 0
        ? topSubjects.join(", ")
        : style !== "—"
          ? style
          : "Works in the Wellcome Collection";

    const bioParts = [
      `${acc.name}${nationality !== "—" ? ` (${nationality})` : ""} is represented in the Wellcome Collection`,
    ];
    if (style !== "—") bioParts.push(`, working chiefly in ${style.toLowerCase()}`);
    if (topSubjects.length > 0) {
      bioParts.push(`, with recurring subjects such as ${topSubjects.join(" and ").toLowerCase()}`);
    }
    if (period !== "—") bioParts.push(`, dating from the ${period}`);
    const bio = `${bioParts.join("")}.`;

    return {
      id: acc.id,
      name: acc.name,
      initials: initialsOf(acc.name),
      profileType: "historical",
      lifespan,
      nationality,
      period,
      style,
      knownFor,
      bio,
      // No social graph upstream — synthesise stable, plausible numbers.
      followers: seededInt(acc.id, 3_000, 400_000),
      likes: seededInt(acc.id + ":likes", 10_000, 1_500_000),
      saves: seededInt(acc.id + ":saves", 4_000, 500_000),
    };
  }

  // ── Field extraction helpers ────────────────────────────────────────────

  /** The IIIF image identifier, taken from the thumbnail or iiif-image URL. */
  private identifierOf(work: WcWork): string | null {
    const url =
      work.thumbnail?.url ??
      (work.items ?? [])
        .flatMap((i) => i.locations ?? [])
        .find((l) => l.locationType?.id === "iiif-image")?.url ??
      "";
    const match = url.match(/\/image\/([^/]+)/);
    return match ? match[1] : null;
  }

  /**
   * The label of an authority-controlled Person contributor, if any. Wellcome
   * person records are formatted "Surname, Given, dates" (a comma is a strong
   * signal), which is exactly the pool most likely to have a Wikipedia page.
   */
  private personLabelOf(work: WcWork): string | null {
    const person = (work.contributors ?? []).find(
      (c) =>
        c.agent?.label &&
        (c.agent.type === "Person" || c.agent.label.includes(",")),
    );
    return person?.agent?.label?.trim() ?? null;
  }

  /** Named artist from contributors, or parsed from the descriptive title. */
  private artistNameOf(work: WcWork): string | null {
    const contributor = (work.contributors ?? []).find((c) => c.agent?.label);
    if (contributor?.agent?.label) {
      return this.normalizeName(contributor.agent.label) || null;
    }

    // Wellcome titles are richly formatted, e.g. "… Wood engraving by J. Jackson, 1845."
    const title = work.title ?? "";
    const by = title.match(/\bby\s+([^.,;:]+?)(?:,|\.|;|$)/i);
    if (by) return this.cleanArtist(by[1]);
    const after = title.match(/\bafter\s+([^.,;:]+?)(?:,|\.|;|$)/i);
    if (after) return this.cleanArtist(after[1]);
    return null;
  }

  private cleanArtist(raw: string): string | null {
    const name = raw.trim().replace(/\s+/g, " ");
    // Guard against picking up non-name phrases.
    if (name.length < 2 || name.length > 60 || /\d/.test(name)) return null;
    return this.normalizeName(name) || null;
  }

  /**
   * Turn a catalogue-style contributor label into a natural "Given Surname"
   * display name so the frontend's Wikipedia-by-name lookup can actually match
   * it. Examples:
   *   "Jackson, John, 1801-1848"                       → "John Jackson"
   *   "Turner, J. M. W. (Joseph Mallord William), 1775-1851" → "Joseph Mallord William Turner"
   *   "Hogarth, William"                               → "William Hogarth"
   *   "J. Jackson"                                     → "J. Jackson" (unchanged)
   */
  private normalizeName(raw: string): string {
    const s = raw.trim().replace(/\s+/g, " ");

    // A parenthetical often spells out initials, e.g. "(Joseph Mallord William)".
    const paren = s.match(/\(([^)]+)\)/);
    const expansion = paren && !/\d/.test(paren[1]) ? paren[1].trim() : "";
    const body = s.replace(/\([^)]*\)/g, " ");

    // Scrub life/activity dates and their markers from a single name segment.
    // Note: `\b[bd]\.` etc. deliberately require the trailing dot so we never
    // eat a real leading letter (e.g. the "D" of "Dürer", where "ü" is a
    // non-word char and would otherwise create a spurious word boundary).
    const clean = (seg: string): string =>
      seg
        .replace(/\b\d{2,4}\b/g, " ")
        .replace(/\b(?:active|approximately|circa)\b/gi, " ")
        .replace(/\b(?:approx|ca|fl|b|d)\./gi, " ")
        .replace(/[-–]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[.\s]+|[.\s]+$/g, "")
        .trim();

    const segs = body
      .split(",")
      .map(clean)
      .filter(Boolean)
      .filter((seg) => !/^(?:sir|dr\.?|mr\.?|mrs\.?|ms\.?|jr\.?|sr\.?)$/i.test(seg));

    // Flip "Surname, Given" → "Given Surname"; prefer the fuller expansion.
    let out: string;
    if (segs.length >= 2) out = `${expansion || segs[1]} ${segs[0]}`;
    else if (segs.length === 1) out = expansion ? `${expansion} ${segs[0]}` : segs[0];
    else out = expansion;

    return out.replace(/\s+/g, " ").trim();
  }

  private artistIdOf(name: string): string {
    return name === "Unknown Artist"
      ? "wellcome-unknown-artist"
      : `wellcome-artist-${slugify(name)}`;
  }

  private mediumOf(work: WcWork): string {
    const phys = (work.physicalDescription ?? "").trim();
    if (!phys) return "";
    // e.g. "1 print : wood engraving" → "Wood engraving".
    const afterColon = phys.split(":").pop()?.trim() ?? phys;
    return afterColon.charAt(0).toUpperCase() + afterColon.slice(1);
  }

  /**
   * Wellcome titles are long descriptive sentences that end with the medium and
   * attribution, e.g. "Queen's College, Oxford: its buildings… Wood engraving by
   * J. Jackson, 1845." Reduce them to a short, card-friendly title: drop the
   * medium/attribution tail, prefer the core subject before the first colon,
   * then cap the length.
   */
  private titleOf(work: WcWork): string {
    const raw = (work.title ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "Untitled";

    // Everything from the first medium term onward is attribution, not title.
    const mediumRe =
      /\b(?:colour |color |hand-coloured |hand-colored |wood |line |steel |stipple |process |oil |pencil |chalk |pen )?(?:engraving|lithograph|chromolithograph|etching|mezzotint|woodcut|aquatint|drawing|photograph|photogravure|painting|watercolou?r|halftone|collotype|woodburytype|print)\b/i;

    let t = raw;
    const m = t.match(mediumRe);
    if (m && m.index !== undefined && m.index > 0) {
      t = t.slice(0, m.index);
    }
    t = t.replace(/[\s.;,:–—-]+$/u, "").trim();

    // Prefer the core subject stated before the first colon.
    const colon = t.indexOf(":");
    if (colon > 0) t = t.slice(0, colon).trim();

    const MAX = 60;
    if (t.length > MAX) {
      const slice = t.slice(0, MAX);
      const sp = slice.lastIndexOf(" ");
      t = `${slice.slice(0, sp > 0 ? sp : MAX).trim()}…`;
    }
    return t || "Untitled";
  }

  private describe(work: WcWork): string {
    const desc = stripHtml(work.description);
    if (desc) return this.concise(desc);

    const noteText = (work.notes ?? [])
      .filter((n) => (n.noteType?.label ?? n.noteType?.id) === "Notes")
      .flatMap((n) => n.contents ?? [])
      .join(" ")
      .trim();
    if (noteText) return this.concise(stripHtml(noteText));

    // Synthesise a placard from the metadata. The title is shown separately in
    // the UI, so we deliberately don't repeat it here.
    const sentences: string[] = [];
    const medium = this.mediumOf(work);
    const year = this.yearLabelOf(work);
    const place = this.mostCommon(this.placesOf(work));
    const lead = [medium, year !== "Date unknown" ? year : "", place]
      .filter(Boolean)
      .join(", ");
    if (lead) sentences.push(`${lead}.`);

    const subjects = (work.subjects ?? []).slice(0, 4).map((s) => s.label);
    if (subjects.length) sentences.push(`Depicts ${subjects.join(", ")}.`);

    sentences.push("From the Wellcome Collection.");
    return sentences.join(" ");
  }

  /**
   * Trim a long catalogue description down to a short, card-friendly blurb —
   * some Wellcome descriptions run to well over a thousand characters. Prefer
   * ending on a sentence boundary; otherwise cut on a word and add an ellipsis.
   */
  private concise(text: string, max = 240): string {
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean.length <= max) return clean;

    const slice = clean.slice(0, max);
    const lastStop = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("? "),
    );
    if (lastStop > max * 0.5) return slice.slice(0, lastStop + 1).trim();

    const lastSpace = slice.lastIndexOf(" ");
    return `${slice.slice(0, lastSpace > 0 ? lastSpace : max).trim()}…`;
  }

  private placesOf(work: WcWork): string[] {
    return (work.production ?? []).flatMap((p) => (p.places ?? []).map((x) => x.label));
  }

  private yearLabelOf(work: WcWork): string {
    const labels = (work.production ?? [])
      .flatMap((p) => (p.dates ?? []).map((d) => d.label))
      .filter(Boolean);
    if (labels.length) return labels.join(", ");
    const y = this.startYearOf(work);
    return y != null ? String(y) : "Date unknown";
  }

  private startYearOf(work: WcWork): number | null {
    const labels = (work.production ?? []).flatMap((p) =>
      (p.dates ?? []).map((d) => d.label),
    );
    for (const label of labels) {
      const m = label.match(/(\d{3,4})/);
      if (m) return Number(m[1]);
    }
    // Fall back to a trailing year in the title (e.g. "…, 1845.").
    const tm = (work.title ?? "").match(/(1[0-9]{3}|20[0-2][0-9])/);
    return tm ? Number(tm[1]) : null;
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private accentFor(seed: string): string {
    // Deterministic deep, muted backdrop derived from the work id.
    const hue = hashString(seed) % 360;
    return hslToHex(hue, 32, 26);
  }

  private centuryOf(year: number | null): string {
    if (year == null) return "";
    if (year < 0) return `c. ${Math.abs(year)} BC`;
    return `${Math.floor(year / 100) + 1}th century`;
  }

  private avg(values: number[]): number | null {
    if (values.length === 0) return null;
    return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  }

  /** The `n` most frequent values, ordered by descending frequency. */
  private topCommon(values: string[], n: number): string[] {
    if (values.length === 0) return [];
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([value]) => value);
  }

  private mostCommon(values: string[]): string {
    if (values.length === 0) return "";
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best = "";
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  }
}
