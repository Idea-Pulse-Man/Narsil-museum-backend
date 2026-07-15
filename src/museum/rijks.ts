/**
 * Rijksmuseum — Data Services source (Search API + Linked Art + IIIF).
 * ---------------------------------------------------------------------------
 * Docs: https://data.rijksmuseum.nl/docs/
 *
 * Built on the NEW data services (no API key) — the classic key-based
 * `www.rijksmuseum.nl/api` Collection API is deprecated and will be switched
 * off, so nothing here touches it. Three hops per artwork:
 *
 *   1. Search API (`/search/collection?imageAvailable=true`) → pages of 100
 *      object PIDs (`id.rijksmuseum.nl/…`), paginated by `pageToken`.
 *   2. Each object PID resolves (Linked Data Resolver) to a Linked Art
 *      `HumanMadeObject` JSON-LD document → title, object number, production
 *      (maker, date, technique), materials, type, placard + description.
 *   3. The object's `shows` → `VisualItem` carries the image RIGHTS (kept only
 *      when marked public domain) and points to the `DigitalObject` whose
 *      `access_point` is a IIIF Image API URL (iiif.micr.io) — rewritten from
 *      `/full/max/` to the ingest width.
 *
 * Only works whose image carries a Creative Commons public-domain mark are
 * ingested, so re-hosting to S3 and commercial use are safe. Rate limits are
 * undocumented; object resolution runs in small paced batches.
 */
import type { Artwork, Artist } from "../types/domain.js";
import type { CatalogData, MuseumSource } from "./source.js";
import { inferCategory, inferEmpire } from "./taxonomy.js";
import { cleanArtistName } from "./artistName.js";
import { fetchJsonRetry, HttpStatusError } from "../utils/http.js";
import {
  slugify,
  initialsOf,
  seededInt,
  uniqueTags,
  hslToHex,
  hashString,
} from "../utils/text.js";

// ── Linked Art shapes (only the paths we walk) ──────────────────────────────

interface LaNotation {
  "@language"?: string;
  "@value"?: string;
}

interface LaNode {
  id?: string;
  type?: string;
  content?: string;
  notation?: LaNotation[];
  classified_as?: LaNode[];
  language?: LaNode[];
  identified_by?: LaNode[];
  referred_to_by?: LaNode[];
  part?: LaNode[];
  carried_out_by?: LaNode[];
  digitally_carried_by?: LaNode[];
  access_point?: LaNode[];
  subject_to?: LaNode[];
}

interface LaTimespan {
  identified_by?: LaNode[];
  begin_of_the_begin?: string;
  end_of_the_end?: string;
}

interface LaProduction extends LaNode {
  technique?: LaNode[];
  timespan?: LaTimespan;
}

interface LaObject extends LaNode {
  produced_by?: LaProduction;
  made_of?: LaNode[];
  shows?: LaNode[];
  subject_of?: LaNode[];
}

interface LaSearchPage {
  orderedItems?: { id?: string }[];
  next?: { id?: string };
}

// Getty AAT vocabulary URIs used as type markers throughout the JSON-LD.
const AAT_ENGLISH = "http://vocab.getty.edu/aat/300388277";
const AAT_PREFERRED_NAME = "http://vocab.getty.edu/aat/300404670";
const AAT_ACCESSION_NUMBER = "http://vocab.getty.edu/aat/300312355";
const AAT_ATTRIBUTION = "http://vocab.getty.edu/aat/300435416";
/** Rights URIs that make an image safe to re-host (PD mark or CC0). */
const PUBLIC_DOMAIN_PREFIX = "https://creativecommons.org/publicdomain/";

/** Pages fetched per run at most — one 100-PID page usually satisfies the
 *  limit (the Search API's page size is fixed). */
const MAX_PAGES = 5;
/** Object PIDs resolved concurrently (3 requests each — keep it gentle). */
const OBJ_BATCH = 3;
/** Pause between object-resolution batches. */
const BATCH_PAUSE_MS = 300;
/** Consecutive object failures that abort the run (persistent outage). */
const MAX_CONSECUTIVE_FAILURES = 10;
const DEFAULT_ACCENT = "#22242b";

/**
 * Object type the search is scoped to. The unfiltered collection leads with
 * coins, medals and reproduction prints; paintings are the Rijksmuseum's
 * signature holdings and map cleanly onto the app's browse taxonomy.
 */
const SEARCH_TYPE = "painting";

const JSON_LD_HEADERS = { Accept: "application/ld+json" } as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** JSON-LD compaction collapses single-entry arrays to bare objects — every
 *  list-valued property must be read through this. */
function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Catalogue qualifiers appended to maker names, e.g.
 *  "Adriaen Matham (mentioned on object)" — noise for an artist profile. */
const NAME_QUALIFIER_RE =
  /\s*\((?:mentioned on object|attributed to|workshop of|studio of|circle of|school of|follower of|manner of|copy after|after|possibly|anonymous)[^)]*\)/gi;

/** One artwork's fully-resolved upstream data, ready for mapping. */
interface RijksWork {
  pid: string;
  objectNumber: string;
  title: string;
  artistName: string;
  /** e.g. "(1858-1928)" parsed from the placard line, when present. */
  artistLifespan: string;
  medium: string;
  typeLabel: string;
  materials: string[];
  techniques: string[];
  yearLabel: string;
  startYear: number | null;
  description: string;
  imageUrl: string;
}

export class RijksSource implements MuseumSource {
  /**
   * `pageToken` the NEXT run should start from (undefined = first page), so
   * daily runs walk fresh slices of the collection. Read by the ingest job.
   */
  nextPageToken: string | undefined;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly limit: number,
    /** IIIF size the image URL is rewritten to ("{width},"). */
    private readonly imageWidth: number,
    /** Search page token to resume from. Defaults to the first page. */
    private readonly startPageToken?: string,
  ) {
    this.nextPageToken = startPageToken;
  }

  async fetchCatalog(): Promise<CatalogData> {
    const works = await this.collectWorks();
    if (works.length < this.limit) {
      console.warn(
        `  (Rijksmuseum: kept ${works.length}/${this.limit} works — this slice ` +
          `may be rights- or image-sparse. Re-run to continue.)`,
      );
    }
    return this.mapCatalog(works);
  }

  // ── Ingestion ─────────────────────────────────────────────────────────────

  private async collectWorks(): Promise<RijksWork[]> {
    const kept: RijksWork[] = [];
    const labelCount = new Map<string, number>();
    let token = this.startPageToken;
    let consecutiveFailures = 0;

    for (let page = 0; page < MAX_PAGES && kept.length < this.limit; page++) {
      const url =
        `${this.apiBaseUrl}/search/collection?imageAvailable=true` +
        `&type=${encodeURIComponent(SEARCH_TYPE)}` +
        (token ? `&pageToken=${encodeURIComponent(token)}` : "");
      const res = await fetchJsonRetry<LaSearchPage>(url);

      const pids = (res.orderedItems ?? [])
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id));
      const nextToken = this.tokenOf(res.next?.id);

      // Ran off the end of the collection → wrap to the first page next run.
      if (pids.length === 0) {
        token = undefined;
        if (page === 0 && !this.startPageToken) break;
        continue;
      }

      for (let i = 0; i < pids.length && kept.length < this.limit; i += OBJ_BATCH) {
        const batch = pids.slice(i, i + OBJ_BATCH);
        const resolved = await Promise.all(
          batch.map(async (pid) => {
            try {
              const work = await this.resolveWork(pid);
              consecutiveFailures = 0;
              return work;
            } catch (err) {
              // A missing/odd record is fine to skip; a long unbroken failure
              // streak means the service is down — fail loudly, keep nothing
              // half-baked (the cursor only advances past completed pages).
              consecutiveFailures++;
              if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw err;
              const msg = err instanceof Error ? err.message : String(err);
              if (!(err instanceof HttpStatusError && err.status === 404)) {
                console.warn(`  (Rijksmuseum: skipping ${pid}: ${msg})`);
              }
              return null;
            }
          }),
        );

        for (const work of resolved) {
          if (!work || kept.length >= this.limit) continue;
          const label = `${work.artistName}::${work.title}`
            .toLowerCase()
            .replace(/\s+/g, " ");
          if ((labelCount.get(label) ?? 0) >= 1) continue; // see met.ts
          labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
          kept.push(work);
        }

        if (kept.length < this.limit && i + OBJ_BATCH < pids.length) {
          await sleep(BATCH_PAUSE_MS);
        }
      }

      // Page-granular cursor (like Wellcome): the search token encodes a
      // position, not a page number, so a partially-consumed page still
      // advances — re-reading it would re-keep the same first works and the
      // ingest would never move forward.
      token = nextToken;
    }

    this.nextPageToken = token;
    return kept;
  }

  /** Extract the `pageToken` query param from the search `next` link. */
  private tokenOf(nextUrl: string | undefined): string | undefined {
    if (!nextUrl) return undefined;
    try {
      return new URL(nextUrl).searchParams.get("pageToken") ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve one object PID through its three Linked Art documents. Returns
   * null when the work has no public-domain image (or no image at all).
   */
  private async resolveWork(pid: string): Promise<RijksWork | null> {
    const obj = await fetchJsonRetry<LaObject>(pid, { headers: JSON_LD_HEADERS });

    const visualId = asArray(obj.shows)[0]?.id;
    if (!visualId) return null;
    const visual = await fetchJsonRetry<LaNode & { digitally_shown_by?: LaNode[] }>(
      visualId,
      { headers: JSON_LD_HEADERS },
    );

    // The IMAGE's rights live on the VisualItem — only a Creative Commons
    // public-domain mark/dedication makes re-hosting safe. Skip everything else.
    const rights = asArray(visual.subject_to)
      .flatMap((right) => asArray(right.classified_as))
      .map((type) => type.id ?? "");
    if (!rights.some((id) => id.startsWith(PUBLIC_DOMAIN_PREFIX))) return null;

    const digitalId = asArray(visual.digitally_shown_by)[0]?.id;
    if (!digitalId) return null;
    const digital = await fetchJsonRetry<LaNode>(digitalId, {
      headers: JSON_LD_HEADERS,
    });
    const accessPoint = asArray(digital.access_point)
      .map((point) => point.id ?? "")
      .find((idUrl) => idUrl.includes("/full/"));
    if (!accessPoint) return null;
    const imageUrl = accessPoint.replace(
      /\/full\/[^/]+\//,
      `/full/${this.imageWidth},/`,
    );

    const production = obj.produced_by;
    const texts = this.collectTexts(asArray(obj.subject_of));
    const placard = this.placardOf(texts);
    const { artistName, artistLifespan } = this.artistOf(production, placard);
    const techniques = this.notationsOf(production?.technique);
    const materials = this.notationsOf(obj.made_of);

    return {
      pid,
      objectNumber: this.objectNumberOf(obj),
      title: this.titleOf(obj),
      artistName,
      artistLifespan,
      medium: this.mediumOf(placard, techniques, materials),
      typeLabel: this.notationsOf(obj.classified_as)[0] ?? "",
      materials,
      techniques,
      yearLabel: this.yearLabelOf(production?.timespan),
      startYear: this.startYearOf(production?.timespan),
      description: this.descriptionOf(texts, placard),
      imageUrl,
    };
  }

  // ── Linked Art extraction helpers ─────────────────────────────────────────

  private hasType(nodes: LaNode | LaNode[] | undefined, typeId: string): boolean {
    return asArray(nodes).some((node) => node.id === typeId);
  }

  /** Preferred English title, then any preferred title, then any Name. */
  private titleOf(obj: LaObject): string {
    const names = asArray(obj.identified_by).filter(
      (node) => node.type === "Name" && node.content,
    );
    const preferred = names.filter((n) =>
      this.hasType(n.classified_as, AAT_PREFERRED_NAME),
    );
    const english = preferred.find((n) => this.hasType(n.language, AAT_ENGLISH));
    return (english ?? preferred[0] ?? names[0])?.content?.trim() || "Untitled";
  }

  private objectNumberOf(obj: LaObject): string {
    const identifier = asArray(obj.identified_by).find(
      (node) =>
        node.type === "Identifier" &&
        this.hasType(node.classified_as, AAT_ACCESSION_NUMBER),
    );
    return identifier?.content?.trim() ?? "";
  }

  /** English `notation` labels of typed nodes (techniques, materials, types). */
  private notationsOf(nodes: LaNode | LaNode[] | undefined): string[] {
    return asArray(nodes)
      .map((node) => {
        const notations = asArray(node.notation);
        const english = notations.find((n) => n["@language"] === "en");
        return (english ?? notations[0])?.["@value"]?.trim() ?? "";
      })
      .filter(Boolean);
  }

  /**
   * Maker name, preferring the actual Person node (`carried_out_by`, possibly
   * nested under production `part`s), then the attribution note, then the
   * placard line ("Jan Toorop (1858-1928), oil on canvas, 1899").
   */
  private artistOf(
    production: LaProduction | undefined,
    placard: string,
  ): { artistName: string; artistLifespan: string } {
    const persons = [
      ...asArray(production?.carried_out_by),
      ...asArray(production?.part).flatMap((p) => asArray(p.carried_out_by)),
    ];
    const personName = this.notationsOf(persons)[0];

    const attribution = asArray(production?.referred_to_by)
      .filter((note) => this.hasType(note.classified_as, AAT_ATTRIBUTION))
      .map((note) => note.content?.trim() ?? "")
      .find(Boolean);

    const placardMatch = placard.match(/^(.*?)\s*\((\d{3,4}\s*[-–]\s*\d{3,4})\)/);

    const artistName =
      cleanArtistName(
        (personName || attribution || placardMatch?.[1] || "").replace(
          NAME_QUALIFIER_RE,
          "",
        ),
      ) ?? "Unknown Artist";
    const artistLifespan = placardMatch?.[2]?.replace(/\s*[-–]\s*/, " – ") ?? "";
    return { artistName, artistLifespan };
  }

  /**
   * Recursively collect every LinguisticObject `content` under `subject_of`,
   * tagging each with the nearest `language` annotation (inherited from the
   * closest ancestor when absent). This flattens the placard/description tree
   * without depending on its exact nesting, which the museum may evolve.
   */
  private collectTexts(
    nodes: LaNode[],
    inheritedEnglish = false,
    out: { content: string; english: boolean }[] = [],
  ): { content: string; english: boolean }[] {
    for (const node of nodes) {
      const english = node.language
        ? this.hasType(node.language, AAT_ENGLISH)
        : inheritedEnglish;
      if (node.type === "LinguisticObject" && node.content?.trim()) {
        out.push({ content: node.content.trim(), english });
      }
      for (const key of ["part", "identified_by", "referred_to_by"] as const) {
        if (node[key]) this.collectTexts(asArray(node[key]), english, out);
      }
    }
    return out;
  }

  /** The tombstone line, e.g. "Jan Toorop (1858-1928), oil on canvas, 1899". */
  private placardOf(texts: { content: string; english: boolean }[]): string {
    return (
      texts
        .map((t) => t.content)
        .filter((c) => /\(\d{3,4}\s*[-–]\s*\d{3,4}\)/.test(c) && c.length < 160)
        .sort((a, b) => a.length - b.length)[0] ?? ""
    );
  }

  /** Longest English prose that isn't the placard — the gallery description. */
  private descriptionOf(
    texts: { content: string; english: boolean }[],
    placard: string,
  ): string {
    const prose = texts
      .filter((t) => t.content !== placard && t.content.length >= 60)
      .sort((a, b) => Number(b.english) - Number(a.english) || b.content.length - a.content.length);
    const best = prose[0]?.content ?? "";
    return this.concise(best);
  }

  /**
   * Medium line: prefer the placard's human phrasing ("oil on canvas") over
   * the bare vocabulary labels ("paint" + "canvas").
   */
  private mediumOf(
    placard: string,
    techniques: string[],
    materials: string[],
  ): string {
    const afterParen = placard.split(/\)\s*,\s*/)[1];
    if (afterParen) {
      const dateOnly =
        /^(?:c\.|ca\.|circa)?\s*\d{3,4}(?:\s*[-–]\s*(?:c\.|ca\.|circa)?\s*\d{3,4})?$/i;
      const segments = afterParen
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !dateOnly.test(s));
      if (segments.length > 0) return segments.join(", ");
    }
    if (techniques.length && materials.length) {
      return `${techniques.join(", ")} on ${materials.join(", ")}`;
    }
    return techniques[0] || materials.join(", ");
  }

  private yearLabelOf(timespan: LaTimespan | undefined): string {
    const named = asArray(timespan?.identified_by)
      .map((n) => n.content?.trim() ?? "")
      .find(Boolean);
    if (named) return named;
    const year = this.startYearOf(timespan);
    return year != null ? String(year) : "Date unknown";
  }

  private startYearOf(timespan: LaTimespan | undefined): number | null {
    const m = (timespan?.begin_of_the_begin ?? "").match(/^(-?\d{1,4})/);
    return m ? Number(m[1]) : null;
  }

  /** Trim long gallery descriptions to a short, card-friendly blurb. */
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

  // ── Mapping (identical shape to any other MuseumSource) ─────────────────────

  private mapCatalog(works: RijksWork[]): CatalogData {
    interface ArtistAccumulator {
      id: string;
      name: string;
      lifespan: string;
      styles: string[];
      years: number[];
    }

    const artistAcc = new Map<string, ArtistAccumulator>();
    const artworks: Artwork[] = [];

    for (const work of works) {
      const artistId = this.artistIdOf(work.artistName);

      const acc =
        artistAcc.get(artistId) ??
        ({
          id: artistId,
          name: work.artistName,
          lifespan: work.artistLifespan,
          styles: [],
          years: [],
        } satisfies ArtistAccumulator);

      if (!acc.lifespan && work.artistLifespan) acc.lifespan = work.artistLifespan;
      if (work.typeLabel) acc.styles.push(work.typeLabel);
      if (work.startYear != null) acc.years.push(work.startYear);
      artistAcc.set(artistId, acc);

      artworks.push(this.mapArtwork(work, artistId));
    }

    const artists = Array.from(artistAcc.values()).map((acc) => this.buildArtist(acc));
    return { artworks, artists };
  }

  private mapArtwork(work: RijksWork, artistId: string): Artwork {
    const signals = {
      classification: work.typeLabel,
      mediumDisplay: work.medium,
      styleTitles: work.techniques,
      termTitles: [work.typeLabel, ...work.techniques, ...work.materials],
    };

    const empire = inferEmpire(signals);
    const seed = work.objectNumber || work.pid;

    return {
      id: `rijks-${slugify(work.objectNumber) || hashString(work.pid)}`,
      title: work.title,
      artistId,
      year: work.yearLabel,
      period: work.typeLabel
        ? work.typeLabel.charAt(0).toUpperCase() + work.typeLabel.slice(1)
        : this.centuryOf(work.startYear) || "—",
      medium: work.medium || "—",
      source: "The Rijksmuseum",
      image: work.imageUrl,
      accent: this.accentFor(seed),
      description:
        work.description ||
        [
          work.artistName !== "Unknown Artist" ? work.artistName : "",
          work.medium,
          work.yearLabel !== "Date unknown" ? work.yearLabel : "",
        ]
          .filter(Boolean)
          .join(" · ") ||
        `${work.title} from the collection of the Rijksmuseum, Amsterdam.`,
      tags: uniqueTags([work.typeLabel, ...work.techniques, ...work.materials]),
      category: inferCategory(signals),
      origin: "public-domain",
      ...(empire ? { empire } : {}),
    };
  }

  private buildArtist(acc: {
    id: string;
    name: string;
    lifespan: string;
    styles: string[];
    years: number[];
  }): Artist {
    const style = this.mostCommon(acc.styles) || "—";
    const lifespan = acc.lifespan || this.centuryOf(this.avg(acc.years)) || "—";
    const period = this.centuryOf(this.avg(acc.years)) || "—";

    const bio =
      `${acc.name}${lifespan !== "—" ? ` (${lifespan})` : ""} is represented ` +
      `in the collection of the Rijksmuseum, Amsterdam` +
      (style !== "—" ? `, known for works such as ${style}s` : "") +
      `.`;

    return {
      id: acc.id,
      name: acc.name,
      initials: initialsOf(acc.name),
      profileType: "historical",
      lifespan,
      // Nationality would need resolving each maker's Person record (one more
      // request per artist) — left for the frontend's Wikipedia lookup.
      nationality: "—",
      period,
      style,
      knownFor: style !== "—" ? style : "Museum collection",
      bio,
      // No social graph upstream — synthesise stable, plausible numbers.
      followers: seededInt(acc.id, 5_000, 900_000),
      likes: seededInt(acc.id + ":likes", 20_000, 3_000_000),
      saves: seededInt(acc.id + ":saves", 8_000, 500_000),
    };
  }

  private artistIdOf(name: string): string {
    return name === "Unknown Artist"
      ? "rijks-unknown-artist"
      : `rijks-artist-${slugify(name)}`;
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private accentFor(seed: string): string {
    const hue = hashString(seed) % 360;
    return hslToHex(hue, 32, 26) || DEFAULT_ACCENT;
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
