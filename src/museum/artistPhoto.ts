/**
 * Resolves a portrait/representative photo for an artist by name via Wikidata.
 *
 * Runs server-side so clients on networks that block en.wikipedia.org can still
 * get portraits through this backend. The flow mirrors the frontend's previous
 * browser lookup:
 *   1. Map the name to a Wikidata entity (QID).
 *   2. Require the entity be a human (P31 → Q5) with an image (P18).
 *
 * Results are cached in-memory with TTL so repeat lookups are fast.
 */

const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MISS_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const REQUEST_TIMEOUT_MS = 8000;
const THUMB_SIZE = 240;

const COMMONS_FILEPATH =
  "https://commons.wikimedia.org/wiki/Special:FilePath/";

const UNRESOLVABLE =
  /^(unknown artist|unknown|anonymous|unidentified|various)$/i;

const NON_PERSON =
  /\b(workshop|atelier|manufactory|studio of|school|master of|circle of|follower of|manner of|attributed to|imitator of|anonymous|unidentified)\b/i;

// Wellcome-style generic descriptors that name no real person and must never
// resolve to a stranger's photo: "a Chinese artist", "an English painter", etc.
const GENERIC_DESCRIPTOR =
  /^an?\s+.*\b(artist|painter|sculptor|engraver|printmaker|illustrator|dra[uf]ghtsman|photographer|architect|designer|potter|goldsmith|ceramicist|muralist|caricaturist|etcher|maker|master|craftsman|calligrapher|scribe)s?\b/i;

const looksLikePerson =
  /\b(painter|artist|sculptor|engraver|printmaker|illustrator|draughtsman|photographer|architect|designer|potter|goldsmith|ceramicist|muralist|caricaturist|etcher|draftsman)\b/i;

/**
 * True when a name is an anonymous/generic attribution (workshop, national
 * school, "a Chinese artist"…) that has no personal likeness — so we never
 * resolve, download, or attach a portrait for it.
 */
export function isUnresolvablePortraitName(name: string): boolean {
  const key = name.trim();
  if (!key) return true;
  return (
    UNRESOLVABLE.test(key) || NON_PERSON.test(key) || GENERIC_DESCRIPTOR.test(key)
  );
}

const USER_AGENT = "narsil-museum-backend/1.0 (+https://github.com/narsil)";

interface CacheEntry {
  url: string | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null>>();

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
      }
    >;
  };
}

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
    P18?: Array<{ mainsnak?: { datavalue?: { value?: string } } }>;
  };
}

async function portraitForEntity(qid: string): Promise<string | null> {
  const data = await fetchJson<{ entities?: Record<string, WikidataEntity> }>(
    `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`,
  );
  const entity = data?.entities?.[qid];
  if (!entity) return null;

  const isHuman = (entity.claims?.P31 ?? []).some(
    (c) => c.mainsnak?.datavalue?.value?.id === "Q5",
  );
  if (!isHuman) return null;

  const file = entity.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!file) return null;

  return `${COMMONS_FILEPATH}${encodeURIComponent(file)}?width=${THUMB_SIZE}`;
}

async function requestPhoto(name: string): Promise<string | null> {
  const qid = await resolveEntityId(name);
  if (!qid) return null;
  return portraitForEntity(qid);
}

function readCache(name: string): string | null | undefined {
  const entry = cache.get(name);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(name);
    return undefined;
  }
  return entry.url;
}

function writeCache(name: string, url: string | null): void {
  const ttl = url ? HIT_TTL_MS : MISS_TTL_MS;
  cache.set(name, { url, expiresAt: Date.now() + ttl });
}

/** Resolve a portrait URL for an artist name, or null when none exists. */
export function getArtistPhotoUrl(name: string): Promise<string | null> {
  const key = name.trim();
  if (!key || isUnresolvablePortraitName(key)) {
    return Promise.resolve(null);
  }

  const cached = readCache(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = requestPhoto(key)
    .then((url) => {
      writeCache(key, url);
      inFlight.delete(key);
      return url;
    })
    .catch(() => {
      writeCache(key, null);
      inFlight.delete(key);
      return null;
    });

  inFlight.set(key, promise);
  return promise;
}
