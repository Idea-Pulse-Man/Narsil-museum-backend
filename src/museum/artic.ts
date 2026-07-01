/**
 * Art Institute of Chicago — museum Public API source.
 * ---------------------------------------------------------------------------
 * Docs: https://api.artic.edu/docs/
 *
 * This module is the single place that knows about the upstream API shape. It:
 *   1. Pulls public-domain artworks that have an associated image.
 *   2. Builds each artwork's image URL via the IIIF Image API 3.0 service.
 *   3. Extracts the title, description/content, medium, dating and artist info.
 *   4. Resolves the referenced artists (AIC "agents") into artist profiles.
 *   5. Maps everything onto the frontend's `Artwork` / `Artist` domain types.
 *
 * Nothing else in the codebase imports the AIC types directly — swap this file
 * (or add a sibling source) to support a different museum without touching the
 * routes, cache, or frontend.
 */
import type { Artwork, Artist } from "../types/domain.js";
import type { ImageResolver } from "./imaging.js";
import { inferCategory, inferEmpire } from "./taxonomy.js";
import { fetchJson, chunk } from "../utils/http.js";
import {
  stripHtml,
  slugify,
  initialsOf,
  seededInt,
  firstSentence,
  uniqueTags,
  hslToHex,
} from "../utils/text.js";

// ── Upstream API shapes (only the fields we request) ──────────────────────

interface AicColor {
  h: number;
  l: number;
  s: number;
  percentage?: number;
  population?: number;
}

interface AicArtwork {
  id: number;
  title: string | null;
  artist_id: number | null;
  artist_title: string | null;
  artist_display: string | null;
  place_of_origin: string | null;
  date_display: string | null;
  date_start: number | null;
  date_end: number | null;
  medium_display: string | null;
  credit_line: string | null;
  description: string | null;
  short_description: string | null;
  is_public_domain: boolean;
  image_id: string | null;
  color: AicColor | null;
  style_title: string | null;
  style_titles: string[] | null;
  classification_title: string | null;
  classification_titles: string[] | null;
  department_title: string | null;
  term_titles: string[] | null;
  subject_titles: string[] | null;
}

interface AicAgent {
  id: number;
  title: string | null;
  birth_date: number | null;
  death_date: number | null;
  description: string | null;
}

interface AicListResponse<T> {
  data: T[];
  pagination?: {
    total: number;
    total_pages: number;
    current_page: number;
    limit: number;
  };
  config?: {
    iiif_url?: string;
    website_url?: string;
  };
}

const ARTWORK_FIELDS = [
  "id",
  "title",
  "artist_id",
  "artist_title",
  "artist_display",
  "place_of_origin",
  "date_display",
  "date_start",
  "date_end",
  "medium_display",
  "credit_line",
  "description",
  "short_description",
  "is_public_domain",
  "image_id",
  "color",
  "style_title",
  "style_titles",
  "classification_title",
  "classification_titles",
  "department_title",
  "term_titles",
  "subject_titles",
].join(",");

const AGENT_FIELDS = ["id", "title", "birth_date", "death_date", "description"].join(",");

const PAGE_SIZE = 100;
const MAX_PAGES = 12;
const DEFAULT_ACCENT = "#22242b";

export interface CatalogData {
  artworks: Artwork[];
  artists: Artist[];
}

export class ArticSource {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly images: ImageResolver,
    private readonly limit: number,
  ) {}

  /** Fetch, filter, and map a full catalog of artworks + their artists. */
  async fetchCatalog(): Promise<CatalogData> {
    const rawArtworks = await this.collectPublicDomainArtworks();

    // Resolve every referenced artist (AIC "agent") in bulk.
    const agentIds = Array.from(
      new Set(
        rawArtworks
          .map((a) => a.artist_id)
          .filter((id): id is number => typeof id === "number"),
      ),
    );
    const agents = await this.fetchAgents(agentIds);

    return this.mapCatalog(rawArtworks, agents);
  }

  // ── Ingestion ───────────────────────────────────────────────────────────

  /** Page through the collection, keeping public-domain works that have art. */
  private async collectPublicDomainArtworks(): Promise<AicArtwork[]> {
    const collected: AicArtwork[] = [];

    for (let page = 1; page <= MAX_PAGES && collected.length < this.limit; page++) {
      const url =
        `${this.apiBaseUrl}/artworks` +
        `?fields=${encodeURIComponent(ARTWORK_FIELDS)}` +
        `&limit=${PAGE_SIZE}&page=${page}`;

      const res = await fetchJson<AicListResponse<AicArtwork>>(url);

      // Prefer the API's advertised IIIF endpoint when the operator didn't pin
      // one explicitly (keeps us correct if AIC moves their image server).
      if (res.config?.iiif_url) {
        this.images.onDiscoveredBase(res.config.iiif_url);
      }

      for (const art of res.data) {
        if (art.is_public_domain && art.image_id && art.title) {
          collected.push(art);
          if (collected.length >= this.limit) break;
        }
      }

      const totalPages = res.pagination?.total_pages ?? page;
      if (page >= totalPages) break;
    }

    return collected;
  }

  /** Bulk-resolve agents by id into a lookup map. */
  private async fetchAgents(ids: number[]): Promise<Map<number, AicAgent>> {
    const map = new Map<number, AicAgent>();
    if (ids.length === 0) return map;

    for (const batch of chunk(ids, PAGE_SIZE)) {
      const url =
        `${this.apiBaseUrl}/agents` +
        `?ids=${batch.join(",")}` +
        `&fields=${encodeURIComponent(AGENT_FIELDS)}` +
        `&limit=${PAGE_SIZE}`;
      try {
        const res = await fetchJson<AicListResponse<AicAgent>>(url);
        for (const agent of res.data) map.set(agent.id, agent);
      } catch {
        // A failed agent batch shouldn't sink the whole catalog — artworks fall
        // back to `artist_title` / "Unknown Artist" below.
      }
    }

    return map;
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  private mapCatalog(
    rawArtworks: AicArtwork[],
    agents: Map<number, AicAgent>,
  ): CatalogData {
    /** Accumulates per-artist facts gathered while mapping their artworks. */
    interface ArtistAccumulator {
      id: string;
      name: string;
      agentId: number | null;
      places: string[];
      styles: string[];
      dateStarts: number[];
    }

    const artistAcc = new Map<string, ArtistAccumulator>();
    const artworks: Artwork[] = [];

    for (const raw of rawArtworks) {
      const { artistId, artistName } = this.resolveArtistRef(raw, agents);

      const acc =
        artistAcc.get(artistId) ??
        ({
          id: artistId,
          name: artistName,
          agentId: raw.artist_id ?? null,
          places: [],
          styles: [],
          dateStarts: [],
        } satisfies ArtistAccumulator);
      if (raw.place_of_origin) acc.places.push(raw.place_of_origin);
      if (raw.style_title) acc.styles.push(raw.style_title);
      if (typeof raw.date_start === "number") acc.dateStarts.push(raw.date_start);
      artistAcc.set(artistId, acc);

      artworks.push(this.mapArtwork(raw, artistId));
    }

    const artists = Array.from(artistAcc.values()).map((acc) =>
      this.buildArtist(acc, agents),
    );

    return { artworks, artists };
  }

  /** Determine a stable artist id + display name for an artwork. */
  private resolveArtistRef(
    raw: AicArtwork,
    agents: Map<number, AicAgent>,
  ): { artistId: string; artistName: string } {
    if (raw.artist_id != null) {
      const agent = agents.get(raw.artist_id);
      const name = (agent?.title ?? raw.artist_title ?? "Unknown Artist").trim();
      return { artistId: `aic-agent-${raw.artist_id}`, artistName: name };
    }
    if (raw.artist_title) {
      const name = raw.artist_title.trim();
      return { artistId: `aic-artist-${slugify(name)}`, artistName: name };
    }
    return { artistId: "unknown-artist", artistName: "Unknown Artist" };
  }

  private mapArtwork(raw: AicArtwork, artistId: string): Artwork {
    const signals = {
      classification: raw.classification_title,
      classifications: raw.classification_titles ?? [],
      mediumDisplay: raw.medium_display,
      styleTitles: raw.style_titles ?? [],
      placeOfOrigin: raw.place_of_origin,
      departmentTitle: raw.department_title,
      termTitles: raw.term_titles ?? [],
    };

    const category = inferCategory(signals);
    const empire = inferEmpire(signals);

    const image = this.images.urlFor(raw.image_id);

    const tags = uniqueTags([
      raw.style_title,
      ...(raw.style_titles ?? []),
      raw.classification_title,
      ...(raw.term_titles ?? []),
      ...(raw.subject_titles ?? []),
    ]);

    return {
      id: `aic-${raw.id}`,
      title: raw.title ?? "Untitled",
      artistId,
      year: raw.date_display?.trim() || this.yearFromRange(raw),
      period: raw.style_title || raw.department_title || "—",
      medium: raw.medium_display?.trim() || "—",
      source: raw.credit_line?.trim() || "Art Institute of Chicago",
      image,
      accent: this.accentFrom(raw.color),
      description: this.describeArtwork(raw),
      tags,
      category,
      origin: "public-domain",
      ...(empire ? { empire } : {}),
    };
  }

  /** Prefer the museum's own prose; otherwise synthesise a clean placard. */
  private describeArtwork(raw: AicArtwork): string {
    const rich = stripHtml(raw.description);
    if (rich) return rich;

    const short = stripHtml(raw.short_description);
    if (short) return short;

    const parts: string[] = [];
    if (raw.artist_display) parts.push(stripHtml(raw.artist_display));
    if (raw.medium_display) parts.push(raw.medium_display);
    if (raw.date_display) parts.push(raw.date_display);
    if (raw.place_of_origin) parts.push(`Origin: ${raw.place_of_origin}`);
    const composed = parts.join(" · ");
    return (
      composed ||
      `${raw.title ?? "This work"} from the collection of the Art Institute of Chicago.`
    );
  }

  private buildArtist(
    acc: {
      id: string;
      name: string;
      agentId: number | null;
      places: string[];
      styles: string[];
      dateStarts: number[];
    },
    agents: Map<number, AicAgent>,
  ): Artist {
    const agent = acc.agentId != null ? agents.get(acc.agentId) : undefined;
    const bioRaw = stripHtml(agent?.description);

    const lifespan = this.lifespan(agent, acc.dateStarts);
    const nationality = this.mostCommon(acc.places) || "—";
    const style = this.mostCommon(acc.styles) || "—";
    const period = style !== "—" ? style : this.periodFromDates(acc.dateStarts);

    const bio =
      bioRaw ||
      `${acc.name}${lifespan !== "—" ? ` (${lifespan})` : ""} is represented in the ` +
        `collection of the Art Institute of Chicago.`;

    return {
      id: acc.id,
      name: acc.name,
      initials: initialsOf(acc.name),
      profileType: "historical",
      lifespan,
      nationality,
      period,
      style,
      knownFor: firstSentence(bioRaw) || (style !== "—" ? style : "Museum collection"),
      bio,
      // The Public API has no social graph — synthesise stable, plausible
      // engagement numbers so profiles render richly. Deterministic per artist.
      followers: seededInt(acc.id, 5_000, 900_000),
      likes: seededInt(acc.id + ":likes", 20_000, 3_000_000),
      saves: seededInt(acc.id + ":saves", 8_000, 800_000),
    };
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  private accentFrom(color: AicColor | null): string {
    if (!color) return DEFAULT_ACCENT;
    // Nudge toward a deeper backdrop so light-heavy palettes still read behind
    // the feed's white overlay text.
    const l = Math.min(color.l, 42);
    return hslToHex(color.h, color.s, l);
  }

  private yearFromRange(raw: AicArtwork): string {
    if (typeof raw.date_start === "number" && typeof raw.date_end === "number") {
      return raw.date_start === raw.date_end
        ? String(raw.date_start)
        : `${raw.date_start} – ${raw.date_end}`;
    }
    return "Date unknown";
  }

  private lifespan(
    agent: AicAgent | undefined,
    fallbackDates: number[],
  ): string {
    if (agent?.birth_date && agent?.death_date) {
      return `${agent.birth_date} – ${agent.death_date}`;
    }
    if (agent?.birth_date) return `b. ${agent.birth_date}`;
    return this.periodFromDates(fallbackDates);
  }

  private periodFromDates(dates: number[]): string {
    if (dates.length === 0) return "—";
    const avg = Math.round(dates.reduce((a, b) => a + b, 0) / dates.length);
    if (avg < 0) return `c. ${Math.abs(avg)} BC`;
    const century = Math.floor(avg / 100) + 1;
    return `${century}th century`;
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
