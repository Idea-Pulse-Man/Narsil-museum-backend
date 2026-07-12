# Plan — add Harvard Art Museums as a second IIIF source

## Goal

Today the daily cron job (`npm run ingest`, EC2, 03:00) pulls exclusively from
Wellcome Collection. This adds the **Harvard Art Museums** collection as a
second source, ingested in the *same* daily run, so every cron run grows the
catalog from **both** museums instead of choosing one.

```
Wellcome Collection API   ──► IIIF image  ──► S3 ─┐
Harvard Art Museums API   ──► IIIF image  ──► S3 ─┼─► Supabase rows ──► app
Wikidata (artist name)    ──► portrait    ──► S3 ─┘
```

## Why Harvard Art Museums

| Requirement | Harvard Art Museums |
|---|---|
| Real IIIF Image API (not just CDN JPEGs) | Yes — `images[].iiifbaseuri` / `baseimageurl`, served from `ids.lib.harvard.edu/ids/iiif/{id}` |
| Public-domain-friendly JSON API | Yes — `api.harvardartmuseums.org/object` |
| Cost / auth | Free API key, requested via a Google Form (no billing) |
| Rate limit | 2,500 calls/day — a daily batch of ~100–200 items uses a handful of paged calls |
| Fits existing `MuseumSource` interface | Yes, same shape as `WellcomeSource`/`ArticSource` |

Ruled out during research: **Cleveland Museum of Art** doesn't actually serve
IIIF (direct CDN JPEGs only, contradicts the "IIIF API" requirement). **Getty**
and the new **Rijksmuseum** data API use a Linked Art / CIDOC-CRM JSON-LD shape
that's materially more complex to map and higher-risk to get right without
deeper spike time.

## Architecture fit

Nothing about `stageImages`, `stageArtistPhotos`, `S3ImageStore`, or
`SupabaseCatalogStore` needs to change — they already operate on the
source-agnostic `Artwork[]` / `Artist[]` domain types. The only structural
change is in `ingest/run.ts`: today it builds **one** `MuseumSource` from
`MUSEUM_SOURCE`; it needs to build a **list** of sources and merge their
catalogs before staging images.

Artist/artwork IDs already carry a source prefix (`wc-…` / `wellcome-artist-…`
for Wellcome, `aic-…` for Artic), so a `harvard-…` / `harvard-artist-…` prefix
keeps the merged catalog collision-free with no dedup logic needed.

## One IIIF nuance to handle

`IiifImageService` (src/museum/iiif.ts) assumes a **fixed** server base +
**variable** identifier appended to it (`{baseUrl}/{identifier}/full/{size}/0/default.{format}`),
which is how both Wellcome and Artic work.

Harvard's `iiifbaseuri` embeds a **per-image** numeric ID directly in the host
path, e.g. `https://ids.lib.harvard.edu/ids/iiif/45526326`. The fix is the same
pattern already used for Wellcome's `identifierOf()` — extract the trailing
numeric ID with a regex and treat `https://ids.lib.harvard.edu/ids/iiif` as the
fixed base, the numeric ID as the identifier. No change to `IiifImageService`
itself is needed.

## Implementation steps

1. **`src/museum/harvard.ts`** (new) — `HarvardSource implements MuseumSource`,
   modeled directly on `wellcome.ts`:
   - Page `GET https://api.harvardartmuseums.org/object?apikey=…&hasimage=1&size=100&page=N&sort=random`
   - Keep only records with a resolvable IIIF identifier (`images[0].iiifbaseuri`
     present, numeric ID extracted)
   - Map `title`, `dated` → year/period, `medium`, `culture` → origin signal for
     `inferEmpire`/`inferCategory`, `people[]` (role `"Artist"`) → artist name
   - Group artworks into an artist accumulator exactly like `WellcomeSource.mapCatalog`
     (nationality/style/period synthesized from aggregated fields — Harvard has
     no bio text, same situation Wellcome is already in)
   - Own resume cursor: `nextStartPage`, same wrap-at-end-of-collection logic as
     `WellcomeSource`

2. **`src/config/env.ts`** — add:
   - `env.harvard.apiKey` (`HARVARD_API_KEY`, required only when the source is
     enabled)
   - `env.harvard.apiBaseUrl` (default `https://api.harvardartmuseums.org`)
   - Replace the single `MUSEUM_SOURCE` read with `MUSEUM_SOURCES` (comma list,
     e.g. `wellcome,harvard`), keeping `MUSEUM_SOURCE` as a back-compat alias
     when `MUSEUM_SOURCES` is unset so existing deploys don't break silently
   - Optional `HARVARD_CATALOG_LIMIT` (falls back to `CATALOG_LIMIT`) so each
     source's per-run size can be tuned independently

3. **`src/ingest/run.ts`**:
   - `buildSource()` → `buildSources()` returning `MuseumSource[]` per the
     `MUSEUM_SOURCES` list
   - `main()`: fetch each source's catalog, concatenate `artworks`/`artists`
     before `stageImages`/`stageArtistPhotos`/Supabase upsert (single combined
     pass — S3/Supabase code is untouched)
   - `.ingest-state.json`: add `harvardNextPage` alongside `wellcomeNextPage`,
     written only after a successful run, same as today
   - `assertConfig()`: require `HARVARD_API_KEY` only if `harvard` is in the
     active source list

4. **`.env.example`** — document the new vars (`HARVARD_API_KEY`,
   `MUSEUM_SOURCES=wellcome,harvard`).

5. **Local dry run**:
   - `MUSEUM_SOURCES=harvard HARVARD_API_KEY=… npm run ingest` alone first,
     confirm S3 objects (`artworks/harvard-….jpg`) and Supabase rows look right
   - Then `MUSEUM_SOURCES=wellcome,harvard npm run ingest` for the combined run

6. **EC2 rollout** (box is already deployed and cron is already running
   `npm run ingest` daily, per `INGEST.md`):
   - `git pull` on the box
   - Add `HARVARD_API_KEY=…` and `MUSEUM_SOURCES=wellcome,harvard` to the
     existing `.env`
   - No crontab change needed — same command, same schedule
   - Verify after the next 03:00 run: `tail -n 80 ~/narsil-ingest.log`, then
     check Supabase for `id LIKE 'harvard-%'` rows and open a resulting S3 URL

7. **Update `INGEST.md`** — extend the architecture diagram and the
   "Tuning" env var table to cover the two-source setup once step 6 is
   verified in production.

## Rollback

Setting `MUSEUM_SOURCES=wellcome` (or deleting `MUSEUM_SOURCES` to fall back
to `MUSEUM_SOURCE`) reverts to single-source behavior with no code changes —
existing Harvard-sourced rows in Supabase/S3 simply stop growing, nothing is
deleted.

## Open questions for later (not blocking)

- Harvard's `people[]` role field is inconsistently populated for older
  records — expect a meaningfully higher "Unknown Artist" rate than Wellcome,
  same tiering strategy (person > named > anonymous) should still apply.
- No bio/description text comes back from Harvard for artists (same as
  Wellcome) — synthesized bio sentence, consistent with the existing pattern.