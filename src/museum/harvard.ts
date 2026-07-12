/**
 * Harvard Art Museums — museum Public API source.
 * ---------------------------------------------------------------------------
 * Docs: https://github.com/harvardartmuseums/api-docs
 *
 * A second IIIF source (alongside Wellcome), ingested in the same daily run so
 * the catalog grows from both museums. Pulls objects that have a resolvable
 * IIIF image, extracts the title, dating, medium, culture and the credited
 * artist, and maps them onto the frontend's `Artwork` / `Artist` domain types.
 *
 * One nuance vs. Wellcome/Artic: Harvard's IIIF identifier isn't appended to a
 * fixed base — it's embedded in `images[].iiifbaseuri` itself
 * (`https://ids.lib.harvard.edu/ids/iiif/{numeric-id}`). The caller is expected
 * to construct this source's `ImageResolver` with that fixed prefix as the IIIF
 * base and pass the trailing numeric id (extracted below) as the identifier —
 * `IiifImageService` then appends it exactly like any other source.
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

// ── Upstream API shapes (only the fields we use) ───────────────────────────

interface HpWorktype {
  worktype?: string;
}

interface HpPerson {
  name?: string;
  displayname?: string;
  role?: string;
  personid?: number;
  culture?: string;
}

interface HpImage {
  iiifbaseuri?: string;
  imageorder?: number;
}

interface HpRecord {
  id: number;
  title?: string;
  dated?: string;
  datebegin?: number;
  dateend?: number;
  medium?: string;
  technique?: string;
  culture?: string;
  period?: string;
  century?: string;
  classification?: string;
  division?: string;
  department?: string;
  creditline?: string;
  description?: string;
  labeltext?: string;
  commentary?: string;
  people?: HpPerson[];
  images?: HpImage[];
  worktypes?: HpWorktype[];
}

interface HpListResponse<T> {
  info?: { totalrecords?: number; pages?: number; page?: number };
  records?: T[];
}

const PAGE_SIZE = 100;
/** Hard cap on pages fetched in one run, so a huge limit can't hammer the API. */
const MAX_PAGE_CAP = 200;

export class HarvardSource implements MuseumSource {
  /**
   * Page the NEXT run should start from. Advances past the pages this run read
   * (wrapping at the end of the collection) so daily runs pull fresh works
   * rather than re-fetching the same slice. Read by the ingestion job.
   */
  nextStartPage: number;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly apiKey: string,
    private readonly images: ImageResolver,
    private readonly limit: number,
    /** Page to begin paging from (1-based). Defaults to 1. */
    private readonly startPage = 1,
  ) {
    this.nextStartPage = Math.max(1, startPage);
  }

  async fetchCatalog(): Promise<CatalogData> {
    const records = await this.collectRecords();
    return this.mapCatalog(records);
  }

  // ── Ingestion ───────────────────────────────────────────────────────────

  /**
   * Page through objects that have an IIIF image, ranked the same way as
   * `WellcomeSource.collectWorks` so the frontend's artist-portrait lookup gets
   * the most identifiable names first:
   *   1. a credited person with a Harvard authority id (`people[].personid`),
   *   2. any other named maker,
   *   3. anonymous works — used only to top the feed up to `limit`.
   */
  private async collectRecords(): Promise<HpRecord[]> {
    const person: HpRecord[] = [];
    const named: HpRecord[] = [];
    const anonymous: HpRecord[] = [];

    const maxPages = Math.min(
      MAX_PAGE_CAP,
      Math.max(1, Math.ceil(this.limit / PAGE_SIZE) + 4),
    );

    let page = Math.max(1, this.startPage);
    let totalPages = Number.POSITIVE_INFINITY;
    let lastPage = page - 1; // last page actually read (for the resume cursor)
    let read = 0;

    while (read < maxPages) {
      const url =
        `${this.apiBaseUrl}/object` +
        `?apikey=${encodeURIComponent(this.apiKey)}` +
        `&hasimage=1&size=${PAGE_SIZE}&page=${page}&sort=random`;

      const res = await fetchJson<HpListResponse<HpRecord>>(url);
      if (res.info?.pages) totalPages = res.info.pages;
      const records = res.records ?? [];

      // Empty page → we've run off the end. Wrap to the start once; if page 1
      // itself is empty, there's nothing to fetch.
      if (records.length === 0) {
        if (page === 1) break;
        page = 1;
        continue;
      }

      for (const record of records) {
        if (!this.identifierOf(record)) continue;
        if (this.personEntryOf(record)) person.push(record);
        else if (this.artistNameOf(record)) named.push(record);
        else anonymous.push(record);
      }

      lastPage = page;
      read++;

      // Stop once we have enough candidates across all tiers.
      if (person.length + named.length + anonymous.length >= this.limit) break;

      // Advance, wrapping back to the first page at the end of the collection.
      page = page + 1 > totalPages ? 1 : page + 1;
    }

    // Where the next run should resume (one past the last page we read, wrapped).
    this.nextStartPage =
      lastPage + 1 > totalPages || lastPage < 1 ? 1 : lastPage + 1;

    const out: HpRecord[] = [];
    for (const tier of [person, named, anonymous]) {
      for (const record of tier) {
        if (out.length >= this.limit) break;
        out.push(record);
      }
    }
    return out;
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private mapCatalog(records: HpRecord[]): CatalogData {
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

    for (const record of records) {
      const name = this.artistNameOf(record) ?? "Unknown Artist";
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

      for (const culture of this.culturesOf(record)) acc.places.push(culture);
      const genre = record.classification;
      if (genre) acc.genres.push(genre);
      const year = this.startYearOf(record);
      if (year != null) acc.years.push(year);
      artistAcc.set(artistId, acc);

      artworks.push(this.mapArtwork(record, artistId));
    }

    const artists = Array.from(artistAcc.values()).map((acc) => this.buildArtist(acc));
    return { artworks, artists };
  }

  private mapArtwork(record: HpRecord, artistId: string): Artwork {
    const identifier = this.identifierOf(record);
    const medium = this.mediumOf(record);
    const worktypes = (record.worktypes ?? []).map((w) => w.worktype).filter(Boolean) as string[];
    const cultures = this.culturesOf(record);

    const signals = {
      classification: record.classification,
      classifications: worktypes,
      mediumDisplay: medium,
      styleTitles: [record.period, record.century].filter(Boolean) as string[],
      placeOfOrigin: cultures.join(" "),
      departmentTitle: record.department ?? record.division,
      termTitles: [record.classification, ...worktypes].filter(Boolean) as string[],
    };

    const empire = inferEmpire(signals);

    return {
      id: `harvard-${record.id}`,
      title: this.titleOf(record),
      artistId,
      year: this.yearLabelOf(record),
      period: record.period || record.century || this.centuryOf(this.startYearOf(record)) || "—",
      medium: medium || "—",
      source: this.sourceOf(record),
      image: this.images.urlFor(identifier),
      accent: this.accentFor(String(record.id)),
      description: this.describe(record),
      tags: uniqueTags([record.classification, ...worktypes, ...cultures]),
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

    const period = lifespan;
    const topSubjects = this.topCommon(acc.subjects, 2).filter(
      (s) => s.toLowerCase() !== style.toLowerCase(),
    );
    const knownFor =
      topSubjects.length > 0
        ? topSubjects.join(", ")
        : style !== "—"
          ? style
          : "Works in the Harvard Art Museums collection";

    const bioParts = [
      `${acc.name}${nationality !== "—" ? ` (${nationality})` : ""} is represented in the Harvard Art Museums collection`,
    ];
    if (style !== "—") bioParts.push(`, working chiefly in ${style.toLowerCase()}`);
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

  /** Credit line from the record, when present. */
  private sourceOf(record: HpRecord): string {
    return record.creditline?.trim() || "Harvard Art Museums";
  }

  /**
   * The trailing numeric IIIF id from the first image that has one. Harvard's
   * `iiifbaseuri` embeds the id directly in the host path, e.g.
   * "https://ids.lib.harvard.edu/ids/iiif/45526326" → "45526326".
   */
  private identifierOf(record: HpRecord): string | null {
    for (const image of record.images ?? []) {
      const uri = image.iiifbaseuri;
      if (!uri) continue;
      const match = uri.match(/(\d+)\/?$/);
      if (match) return match[1];
    }
    return null;
  }

  /** The credited maker entry, preferring an explicit "Artist" role. */
  private artistEntryOf(record: HpRecord): HpPerson | null {
    const people = record.people ?? [];
    if (people.length === 0) return null;
    const byRole = people.find((p) => /artist/i.test(p.role ?? ""));
    if (byRole) return byRole;
    const byMakerRole = people.find((p) =>
      /painter|sculptor|printmaker|maker|attribut/i.test(p.role ?? ""),
    );
    return byMakerRole ?? people[0];
  }

  /**
   * The credited maker entry, but only when Harvard has resolved it to an
   * authority record (`personid`) — the strongest signal that a Wikipedia
   * portrait will resolve for it, same role Wellcome's `personLabelOf` plays.
   */
  private personEntryOf(record: HpRecord): HpPerson | null {
    const entry = this.artistEntryOf(record);
    return entry?.personid != null ? entry : null;
  }

  private artistNameOf(record: HpRecord): string | null {
    const entry = this.artistEntryOf(record);
    const name = (entry?.displayname ?? entry?.name ?? "").trim();
    return name || null;
  }

  private artistIdOf(name: string): string {
    return name === "Unknown Artist"
      ? "harvard-unknown-artist"
      : `harvard-artist-${slugify(name)}`;
  }

  private culturesOf(record: HpRecord): string[] {
    return record.culture ? [record.culture] : [];
  }

  private mediumOf(record: HpRecord): string {
    return (record.medium ?? record.technique ?? "").trim();
  }

  private titleOf(record: HpRecord): string {
    const raw = stripHtml(record.title).trim();
    return raw || "Untitled";
  }

  private describe(record: HpRecord): string {
    const desc = stripHtml(record.description);
    if (desc) return this.concise(desc);

    const label = stripHtml(record.labeltext);
    if (label) return this.concise(label);

    const commentary = stripHtml(record.commentary);
    if (commentary) return this.concise(commentary);

    // Synthesise a placard from the metadata. The title is shown separately in
    // the UI, so we deliberately don't repeat it here.
    const medium = this.mediumOf(record);
    const year = this.yearLabelOf(record);
    const culture = this.mostCommon(this.culturesOf(record));
    const lead = [medium, year !== "Date unknown" ? year : "", culture]
      .filter(Boolean)
      .join(", ");
    return lead ? `${lead}.` : `From the collection of ${this.sourceOf(record)}.`;
  }

  /**
   * Trim a long catalogue description down to a short, card-friendly blurb.
   * Prefer ending on a sentence boundary; otherwise cut on a word and add an
   * ellipsis.
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

  private yearLabelOf(record: HpRecord): string {
    const dated = (record.dated ?? "").trim();
    if (dated) return dated;
    if (typeof record.datebegin === "number" && typeof record.dateend === "number") {
      return record.datebegin === record.dateend
        ? String(record.datebegin)
        : `${record.datebegin} – ${record.dateend}`;
    }
    const y = this.startYearOf(record);
    return y != null ? String(y) : "Date unknown";
  }

  private startYearOf(record: HpRecord): number | null {
    if (typeof record.datebegin === "number") return record.datebegin;
    const m = (record.dated ?? "").match(/-?\d{3,4}/);
    return m ? Number(m[0]) : null;
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
