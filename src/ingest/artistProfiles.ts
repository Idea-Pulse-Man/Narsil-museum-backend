/**
 * Artist profile cron — AWS EC2 companion to the artwork ingest job.
 * ---------------------------------------------------------------------------
 * Builds For You artist story profiles until TARGET ready cards are made
 * (default 50 / day).
 *
 * Cascade (same for bio and photo):
 *   1. Museum / IIIF catalog data first
 *   2. Wikipedia / Wikidata only when museum photo or bio is missing/thin
 *
 * Rules:
 *   - Still no card without a real person photograph (museum or Wikidata).
 *   - `--limit=N` means make up to N *ready* cards this run (not N attempts).
 *
 * Usage:
 *   npm run ingest:artists -- --dry-run
 *   npm run ingest:artists
 *   npm run ingest:artists -- --limit=50 --force
 *   npm run ingest:artists -- --museum-only   # never call Wikipedia / Wikidata
 *
 * Cron: see INGEST.md (after artwork ingest).
 */
import "dotenv/config";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";
import {
  getArtistPhotoUrl,
  isUnresolvablePortraitName,
} from "../museum/artistPhoto.js";
import {
  composeDetailedArtistBio,
  enrichArtistFromWikipedia,
  isMuseumStubBio,
  museumBioIsSufficient,
  PROFILE_READY_MIN_BIO,
  type CollectionWork,
} from "../museum/artistWiki.js";
import { S3ImageStore } from "./s3.js";

const PAGE = 200;
/** Default number of *ready* artist cards to produce per daily run. */
const DEFAULT_TARGET_READY = 50;
/**
 * One artist at a time. Parallel Wikimedia / Commons hits from a single EC2
 * IP get throttled (429) quickly — sequential is slower but reliable.
 */
const CONCURRENCY = 1;
/** Pause between artists so Wikimedia / Commons do not flag the AWS IP. */
const DELAY_BETWEEN_ARTISTS_MS = 2_500;
/** Extra pause after a Wikipedia / Wikidata round-trip. */
const DELAY_AFTER_WIKI_MS = 1_200;
/** Extra pause after downloading a portrait image. */
const DELAY_AFTER_PORTRAIT_MS = 800;
/** Safety cap so a bad night cannot walk the entire catalog forever. */
const MAX_ATTEMPTS = 500;

const WIKIMEDIA_HEADERS: Record<string, string> = {
  "User-Agent":
    "NarsilMuseumBot/1.0 (https://github.com/Idea-Pulse-Man/Narsil-museum-backend) artist-profiles",
  Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
};

interface ArtistRow {
  id: string;
  name: string;
  bio: string | null;
  known_for: string | null;
  famous_works: string[] | null;
  avatar_url: string | null;
  lifespan: string | null;
  nationality: string | null;
  period: string | null;
  style: string | null;
  profile_type: string | null;
  profile_ready: boolean | null;
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const MUSEUM_ONLY = args.includes("--museum-only");
const limitArg = args.find((a) => a.startsWith("--limit="));
const TARGET_READY = limitArg
  ? Math.max(1, Number(limitArg.split("=")[1]) || DEFAULT_TARGET_READY)
  : DEFAULT_TARGET_READY;

function artistPortraitKey(id: string): string {
  return `${env.aws.s3ArtistPrefix}/${id}.jpg`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleep with a little jitter so request timing is not perfectly metronomic. */
async function politeDelay(baseMs: number): Promise<void> {
  const jitter = Math.floor(Math.random() * Math.min(800, baseMs * 0.4));
  await sleep(baseMs + jitter);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

function hasPortraitUrl(avatarUrl: string | null | undefined): boolean {
  const url = (avatarUrl ?? "").trim();
  return !!url && /^https?:\/\//i.test(url);
}

async function downloadPortrait(
  url: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: WIKIMEDIA_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`portrait HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new Error("empty portrait body");
    return {
      buffer,
      contentType: res.headers.get("content-type") ?? "image/jpeg",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loadBackdropArtwork(
  client: SupabaseClient,
  artistId: string,
): Promise<{ id: string; title: string; image_url: string } | null> {
  const { data, error } = await client
    .from("artworks")
    .select("id, title, image_url")
    .eq("artist_id", artistId)
    .not("image_url", "is", null)
    .or("hidden.is.null,hidden.eq.false")
    .order("featured", { ascending: false })
    .order("like_count", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data?.image_url) return null;
  return {
    id: String(data.id),
    title: String(data.title ?? "").trim(),
    image_url: String(data.image_url),
  };
}

function famousForLine(
  famousWorks: string[],
  knownFor: string,
): string | null {
  if (famousWorks.length > 0) {
    return famousWorks.slice(0, 3).join(" · ");
  }
  const known = knownFor.trim();
  if (known && !/^Museum collection$/i.test(known)) return known;
  return null;
}

async function upsertFypArtistCard(
  client: SupabaseClient,
  row: ArtistRow,
  payload: {
    avatar_url: string;
    bio: string;
    known_for: string;
    famous_works: string[];
  },
  backdrop: { id: string; title: string; image_url: string } | null,
): Promise<void> {
  const cardPayload = {
    artist_id: row.id,
    name: row.name,
    lifespan: row.lifespan,
    nationality: row.nationality,
    portrait_url: payload.avatar_url,
    famous_for: famousForLine(payload.famous_works, payload.known_for),
    bio: payload.bio,
    backdrop_artwork_id: backdrop?.id ?? null,
    backdrop_image_url: backdrop?.image_url ?? null,
    backdrop_title: backdrop?.title || null,
    active: true,
    sort_order: 0,
    updated_at: new Date().toISOString(),
  };

  const { error } = await client
    .from("fyp_artist_cards")
    .upsert(cardPayload, { onConflict: "artist_id" });
  if (error) throw new Error(`fyp_artist_cards: ${error.message}`);
}

async function loadCollectionWorks(
  client: SupabaseClient,
  artistId: string,
): Promise<CollectionWork[]> {
  const { data, error } = await client
    .from("artworks")
    .select("title, source, year, like_count, featured")
    .eq("artist_id", artistId)
    .not("image_url", "is", null)
    .order("featured", { ascending: false })
    .order("like_count", { ascending: false })
    .limit(8);
  if (error) {
    console.warn(`  (collection works for ${artistId}: ${error.message})`);
    return [];
  }
  return (data ?? [])
    .filter((r) => (r.title ?? "").trim().length > 0)
    .map((r) => ({
      title: String(r.title).trim(),
      source: r.source ? String(r.source) : undefined,
      year: r.year ? String(r.year) : undefined,
    }));
}

/**
 * Museum/catalog avatar first; Wikidata only if missing (unless --museum-only).
 */
async function resolvePortrait(
  artist: ArtistRow,
  s3: S3ImageStore | null,
): Promise<{ url: string | null; source: "museum" | "wikipedia" | "none" }> {
  if (isUnresolvablePortraitName(artist.name)) {
    return { url: null, source: "none" };
  }

  if (hasPortraitUrl(artist.avatar_url)) {
    return { url: artist.avatar_url!.trim(), source: "museum" };
  }

  if (MUSEUM_ONLY) return { url: null, source: "none" };

  const key = artistPortraitKey(artist.id);
  if (s3 && env.ingest.skipExisting && (await s3.exists(key))) {
    return { url: s3.publicUrl(key), source: "museum" };
  }

  const portraitUrl = await getArtistPhotoUrl(artist.name);
  if (!portraitUrl) return { url: null, source: "none" };

  if (DRY_RUN || !s3) {
    return { url: portraitUrl, source: "wikipedia" };
  }

  const { buffer, contentType } = await downloadPortrait(portraitUrl);
  const url = await s3.upload(key, buffer, contentType);
  await politeDelay(DELAY_AFTER_PORTRAIT_MS);
  return { url, source: "wikipedia" };
}

function knownForFrom(
  description: string,
  famousWorks: string[],
  existing: string | null,
  style: string | null,
): string {
  if (famousWorks.length > 0) return famousWorks.slice(0, 3).join(", ");
  if (description) return description;
  const known = (existing ?? "").trim();
  if (known && !/^Museum collection$/i.test(known)) return known;
  const s = (style ?? "").trim();
  return s && s !== "—" ? s : known;
}

type ProcessResult =
  | { status: "ready" }
  | { status: "noPhoto" }
  | { status: "noBio" }
  | { status: "thin" }
  | { status: "failed" };

async function processArtist(
  client: SupabaseClient,
  s3: S3ImageStore | null,
  row: ArtistRow,
): Promise<ProcessResult> {
  try {
    const portrait = await resolvePortrait(row, s3);
    if (!portrait.url) {
      if (!DRY_RUN) {
        await client
          .from("artists")
          .update({ profile_ready: false })
          .eq("id", row.id);
      }
      console.log(`  ✗ no photo — skip: ${row.name}`);
      return { status: "noPhoto" };
    }

    const collectionWorks = await loadCollectionWorks(client, row.id);
    const famousFromCatalog = collectionWorks.map((w) => w.title).slice(0, 6);

    const museumOk = museumBioIsSufficient(row.bio, collectionWorks);
    let wiki: Awaited<ReturnType<typeof enrichArtistFromWikipedia>> = null;
    let bioSource = "museum";

    if (!museumOk && !MUSEUM_ONLY) {
      wiki = await enrichArtistFromWikipedia(row.name);
      await politeDelay(DELAY_AFTER_WIKI_MS);
      bioSource = wiki ? "wikipedia+museum" : "museum";
    }

    if (
      !museumOk &&
      (!wiki || (!wiki.bio && wiki.famousWorks.length === 0)) &&
      (isMuseumStubBio(row.bio) || (row.bio ?? "").trim().length < 80)
    ) {
      if (!DRY_RUN) {
        await client
          .from("artists")
          .update({
            avatar_url: portrait.url,
            profile_ready: false,
          })
          .eq("id", row.id);
      }
      console.log(`  ✗ bio too thin — skip: ${row.name}`);
      return { status: "noBio" };
    }

    const famousWorks =
      (wiki?.famousWorks?.length ?? 0) > 0
        ? wiki!.famousWorks
        : (row.famous_works ?? []).filter((w) => w?.trim()).length > 0
          ? (row.famous_works ?? []).map((w) => w.trim()).filter(Boolean)
          : famousFromCatalog;

    const detailedBio = composeDetailedArtistBio({
      museumBio: row.bio ?? "",
      wikiBio: wiki?.bio ?? "",
      description: wiki?.description,
      famousWorks,
      collectionWorks,
      artistName: row.name,
    });

    if (
      detailedBio.length < PROFILE_READY_MIN_BIO ||
      isMuseumStubBio(detailedBio)
    ) {
      if (!DRY_RUN) {
        await client
          .from("artists")
          .update({
            avatar_url: portrait.url,
            profile_ready: false,
          })
          .eq("id", row.id);
      }
      console.log(
        `  ✗ composed bio too thin (${detailedBio.length}c) — skip: ${row.name}`,
      );
      return { status: "thin" };
    }

    const nextPeriod =
      row.period && row.period !== "—"
        ? row.period
        : wiki?.periodHint || row.period;

    const payload = {
      avatar_url: portrait.url,
      bio: detailedBio,
      known_for: knownForFrom(
        wiki?.description ?? "",
        famousWorks,
        row.known_for,
        row.style,
      ),
      famous_works: famousWorks,
      profile_ready: true,
      ...(wiki?.qid
        ? {
            wikidata_qid: wiki.qid,
            wikipedia_url: wiki.wikipediaUrl ?? null,
            wiki_enriched_at: new Date().toISOString(),
          }
        : {}),
      ...(nextPeriod ? { period: nextPeriod } : {}),
    };

    if (!DRY_RUN) {
      const { error } = await client
        .from("artists")
        .update(payload)
        .eq("id", row.id);
      if (error) throw new Error(error.message);

      const backdrop = await loadBackdropArtwork(client, row.id);
      await upsertFypArtistCard(client, row, payload, backdrop);
    }

    console.log(
      `  ✓ ${row.name} [bio=${bioSource}, photo=${portrait.source}] ` +
        `(bio ${detailedBio.length}c, ${famousWorks.length} works, ${collectionWorks.length} in catalog)`,
    );
    return { status: "ready" };
  } catch (err) {
    console.warn(
      `  ✗ ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { status: "failed" };
  }
}

async function loadCandidatePage(
  client: SupabaseClient,
  from: number,
): Promise<ArtistRow[]> {
  let query = client
    .from("artists")
    .select(
      "id, name, bio, known_for, famous_works, avatar_url, lifespan, nationality, period, style, profile_type, profile_ready",
    )
    .eq("profile_type", "historical")
    .order("followers", { ascending: false })
    .order("id")
    .range(from, from + PAGE - 1);

  if (!FORCE) {
    query = query.or("profile_ready.is.null,profile_ready.eq.false");
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as ArtistRow[]).filter(
    (row) => !isUnresolvablePortraitName(row.name),
  );
}

async function main(): Promise<void> {
  if (!env.supabase.url || !env.supabase.serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const client = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const s3 =
    DRY_RUN || MUSEUM_ONLY
      ? null
      : env.aws.s3Bucket
        ? new S3ImageStore()
        : null;

  console.log(
    `Artist profiles targetReady=${TARGET_READY}` +
      `${DRY_RUN ? " (dry-run)" : ""}` +
      `${FORCE ? " (force)" : ""}` +
      `${MUSEUM_ONLY ? " (museum-only)" : " (museum first, Wikipedia if needed)"}` +
      ` concurrency=${CONCURRENCY} delay≈${DELAY_BETWEEN_ARTISTS_MS}ms/artist`,
  );

  let ready = 0;
  let noPhoto = 0;
  let noBio = 0;
  let thin = 0;
  let failed = 0;
  let attempted = 0;
  let from = 0;
  let exhausted = false;

  // Keep pulling candidates until we hit TARGET_READY ready cards (or caps).
  while (ready < TARGET_READY && attempted < MAX_ATTEMPTS && !exhausted) {
    const page = await loadCandidatePage(client, from);
    if (page.length === 0) {
      exhausted = true;
      break;
    }
    from += PAGE;

    // One (or few) at a time with a pause between artists — protects the EC2
    // IP from Wikimedia / Commons rate limits.
    const chunkSize = CONCURRENCY;
    for (let i = 0; i < page.length && ready < TARGET_READY; i += chunkSize) {
      const batch = page.slice(i, i + chunkSize);
      const results = await mapLimit(batch, CONCURRENCY, (row) =>
        processArtist(client, s3, row),
      );

      for (const r of results) {
        attempted++;
        if (r.status === "ready") {
          if (ready < TARGET_READY) ready++;
        } else if (r.status === "noPhoto") noPhoto++;
        else if (r.status === "noBio") noBio++;
        else if (r.status === "thin") thin++;
        else failed++;
      }

      if (ready < TARGET_READY && i + chunkSize < page.length) {
        await politeDelay(DELAY_BETWEEN_ARTISTS_MS);
      }
    }

    if (page.length < PAGE) exhausted = true;
  }

  console.log(
    `Done. ready=${ready}/${TARGET_READY} attempted=${attempted} ` +
      `noPhoto=${noPhoto} noBio=${noBio} thin=${thin} failed=${failed}` +
      `${exhausted ? " (pool exhausted)" : ""}` +
      `${DRY_RUN ? " (dry-run)" : ""}`,
  );
  if (ready < TARGET_READY) {
    console.log(
      `Stopped early with ${ready} ready (wanted ${TARGET_READY}). ` +
        `More museum ingest or a larger artist pool will help tomorrow.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
