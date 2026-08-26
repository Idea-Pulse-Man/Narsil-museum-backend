/**
 * Wikipedia / Wikidata enrichment for historical artists.
 *
 * Used by the artist-profile cron (`npm run ingest:artists`) and artwork ingest:
 *   1. Resolve a human Wikidata QID for the artist name (same rules as portraits).
 *   2. Fetch a long English Wikipedia plain-text extract (not the thin museum stub).
 *   3. Read Wikidata P800 (notable work) labels → famous_works titles.
 *   4. Compose a detailed bio that includes famous works + museum collection titles.
 *
 * Only person entities (P31 → Q5) are accepted — never workshops or artworks.
 */

import { isUnresolvablePortraitName } from "./artistPhoto.js";

const USER_AGENT =
  "NarsilMuseumBot/1.0 (https://github.com/Idea-Pulse-Man/Narsil-museum-backend) artist-profiles";
const REQUEST_TIMEOUT_MS = 12_000;
/** Target length for the Wikipedia plain-text extract. */
const WIKI_EXTRACT_CHARS = 2200;

export interface ArtistWikiEnrichment {
  qid: string;
  wikipediaUrl?: string;
  /** Long Wikipedia extract (plain text). */
  bio: string;
  /** Short Wikipedia description (e.g. "Dutch Post-Impressionist painter"). */
  description: string;
  /** Recognizable work titles from Wikidata P800. */
  famousWorks: string[];
  /** Optional lifespan hint from the Wikipedia description / extract. */
  lifespanHint?: string;
  periodHint?: string;
}

export interface CollectionWork {
  title: string;
  source?: string;
  year?: string;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface WikiQueryResponse {
  query?: {
    pages?: Record<
      string,
      {
        index?: number;
        missing?: string;
        pageprops?: { wikibase_item?: string };
        terms?: { description?: string[] };
        extract?: string;
        title?: string;
        fullurl?: string;
      }
    >;
  };
}

const looksLikePerson =
  /\b(painter|artist|sculptor|engraver|printmaker|illustrator|draughtsman|photographer|architect|designer|potter|goldsmith|ceramicist|muralist|caricaturist|etcher|draftsman|composer|writer|philosopher|poet)\b/i;

async function resolveEntityId(name: string): Promise<string | null> {
  const titleParams = new URLSearchParams({
    action: "query",
    format: "json",
    redirects: "1",
    titles: name,
    prop: "pageprops",
    ppprop: "wikibase_item",
  });
  const titleData = await fetchJson<WikiQueryResponse>(
    `https://en.wikipedia.org/w/api.php?${titleParams.toString()}`,
  );
  const exact = Object.values(titleData?.query?.pages ?? {}).find(
    (p) => !p.missing && p.pageprops?.wikibase_item,
  );
  if (exact?.pageprops?.wikibase_item) return exact.pageprops.wikibase_item;

  const searchParams = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${name} artist`,
    gsrlimit: "5",
    gsrnamespace: "0",
    prop: "pageprops|pageterms",
    ppprop: "wikibase_item",
    wbptterms: "description",
  });
  const searchData = await fetchJson<WikiQueryResponse>(
    `https://en.wikipedia.org/w/api.php?${searchParams.toString()}`,
  );
  const pages = Object.values(searchData?.query?.pages ?? {}).sort(
    (a, b) => (a.index ?? 999) - (b.index ?? 999),
  );
  const person = pages.find(
    (p) =>
      p.pageprops?.wikibase_item &&
      (p.terms?.description ?? []).some((d) => looksLikePerson.test(d)),
  );
  return person?.pageprops?.wikibase_item ?? null;
}

interface WikidataEntity {
  claims?: {
    P31?: Array<{ mainsnak?: { datavalue?: { value?: { id?: string } } } }>;
    P800?: Array<{
      mainsnak?: { datavalue?: { value?: { id?: string } } };
    }>;
  };
  labels?: { en?: { value?: string } };
  sitelinks?: { enwiki?: { title?: string; url?: string } };
}

interface WikiSummary {
  type?: string;
  title?: string;
  extract?: string;
  description?: string;
  content_urls?: { desktop?: { page?: string } };
}

function isHumanEntity(entity: WikidataEntity): boolean {
  return (entity.claims?.P31 ?? []).some(
    (c) => c.mainsnak?.datavalue?.value?.id === "Q5",
  );
}

async function loadEntity(qid: string): Promise<WikidataEntity | null> {
  const data = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(
    `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`,
  );
  return data?.entities?.[qid] ?? null;
}

async function notableWorkTitles(entity: WikidataEntity): Promise<string[]> {
  const workIds = (entity.claims?.P800 ?? [])
    .map((c) => c.mainsnak?.datavalue?.value?.id)
    .filter((id): id is string => !!id)
    .slice(0, 8);

  if (workIds.length === 0) return [];

  const titles: string[] = [];
  for (const workId of workIds) {
    const work = await loadEntity(workId);
    const label = work?.labels?.en?.value?.trim();
    if (label) titles.push(label);
  }
  return titles;
}

/** Long plain-text extract — more detail than the REST summary alone. */
async function wikipediaExtractForTitle(
  title: string,
): Promise<{ bio: string; url?: string } | null> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    redirects: "1",
    prop: "extracts|info",
    explaintext: "1",
    exsectionformat: "plain",
    exchars: String(WIKI_EXTRACT_CHARS),
    inprop: "url",
    titles: title,
  });
  const data = await fetchJson<WikiQueryResponse>(
    `https://en.wikipedia.org/w/api.php?${params.toString()}`,
  );
  const page = Object.values(data?.query?.pages ?? {}).find(
    (p) => !p.missing && (p.extract ?? "").trim().length > 0,
  );
  if (!page?.extract) return null;
  const bio = page.extract
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (bio.length < 80) return null;
  return { bio, url: page.fullurl };
}

async function wikipediaSummaryForTitle(
  title: string,
): Promise<{ description: string; url?: string; shortExtract: string } | null> {
  const summary = await fetchJson<WikiSummary>(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  );
  if (!summary || summary.type === "disambiguation") return null;
  return {
    description: (summary.description ?? "").trim(),
    url: summary.content_urls?.desktop?.page,
    shortExtract: (summary.extract ?? "").trim(),
  };
}

/**
 * Resolve Wikipedia bio + famous works for an artist name.
 * Returns null when the name is not a real person or has no English article.
 */
export async function enrichArtistFromWikipedia(
  name: string,
): Promise<ArtistWikiEnrichment | null> {
  const key = name.trim();
  if (!key || isUnresolvablePortraitName(key)) return null;

  const qid = await resolveEntityId(key);
  if (!qid) return null;

  const entity = await loadEntity(qid);
  if (!entity || !isHumanEntity(entity)) return null;

  const wikiTitle = entity.sitelinks?.enwiki?.title;
  if (!wikiTitle) return null;

  const [longExtract, summary, famousWorks] = await Promise.all([
    wikipediaExtractForTitle(wikiTitle),
    wikipediaSummaryForTitle(wikiTitle),
    notableWorkTitles(entity),
  ]);

  const bio = longExtract?.bio || summary?.shortExtract || "";
  if (!bio && famousWorks.length === 0) return null;

  const description = summary?.description ?? "";
  return {
    qid,
    wikipediaUrl:
      longExtract?.url ??
      summary?.url ??
      entity.sitelinks?.enwiki?.url ??
      undefined,
    bio,
    description,
    famousWorks,
    periodHint: description || undefined,
  };
}

/**
 * Compose the For You / profile bio.
 *
 * Prefer museum / IIIF catalog copy when it is already rich; Wikipedia is only
 * mixed in when needed. Always append famous works + collection titles when we
 * have them.
 */
export function composeDetailedArtistBio(opts: {
  /** Existing museum / catalog bio (from artwork ingest). */
  museumBio?: string;
  /** Wikipedia extract — used when museum bio is thin or missing. */
  wikiBio?: string;
  description?: string;
  famousWorks: string[];
  collectionWorks: CollectionWork[];
  artistName: string;
}): string {
  const parts: string[] = [];
  const museum = (opts.museumBio ?? "").trim();
  const wiki = (opts.wikiBio ?? "").trim();

  if (museum && !isMuseumStubBio(museum) && museum.length >= 120) {
    parts.push(museum);
    // Add Wikipedia only when it clearly adds more detail.
    if (wiki && wiki.length > museum.length + 80 && !wiki.startsWith(museum.slice(0, 40))) {
      parts.push(wiki);
    }
  } else if (wiki) {
    parts.push(wiki);
  } else if (museum) {
    parts.push(museum);
  }

  if (opts.famousWorks.length > 0) {
    const list = opts.famousWorks.slice(0, 5).join("; ");
    parts.push(`Among the works most people know: ${list}.`);
  } else if (opts.description) {
    parts.push(`${opts.artistName} is remembered as ${opts.description}.`);
  }

  if (opts.collectionWorks.length > 0) {
    const samples = opts.collectionWorks.slice(0, 4).map((w) => {
      const museumName = w.source?.trim();
      const year = w.year?.trim();
      const meta = [year, museumName].filter(Boolean).join(", ");
      return meta ? `"${w.title}" (${meta})` : `"${w.title}"`;
    });
    parts.push(
      `In museum collections featured on Narsil: ${samples.join("; ")}.`,
    );
  }

  return parts.join("\n\n").trim();
}

/**
 * True when the museum/IIIF catalog alone is enough for a story card bio
 * (no Wikipedia call required).
 */
export function museumBioIsSufficient(
  bio: string | null | undefined,
  collectionWorks: CollectionWork[],
): boolean {
  const text = (bio ?? "").trim();
  if (isMuseumStubBio(text)) return false;
  if (text.length < PROFILE_READY_MIN_BIO) return false;
  // Need at least a couple of catalog works so the card can talk about them.
  return collectionWorks.length >= 2;
}

/** Museum ingest stubs that should never appear on artist story cards. */
export function isMuseumStubBio(bio?: string | null): boolean {
  const text = (bio ?? "").trim();
  if (!text) return true;
  if (/is represented in the (collection|Open Access)/i.test(text)) return true;
  if (/preparatory stud/i.test(text)) return true;
  if (/Museum collection/i.test(text) && text.length < 120) return true;
  return false;
}

/** Minimum bio length before an artist profile is marked ready for the feed. */
export const PROFILE_READY_MIN_BIO = 180;
