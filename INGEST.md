# Daily image ingestion — EC2 setup

The ingestion job pulls public-domain artworks from a museum API, uploads the
images to **S3** (`narsil-backend-images`), and upserts artworks + artists into
**Supabase**. The app then reads the catalog directly from Supabase and loads
images straight from S3.

```
Wellcome Collection API   ──►  download IIIF image     ──►  S3 (public)  ─┐
Harvard Art Museums API   ──►  download IIIF image     ──►  S3 (public)  ─┼─►  Supabase rows  ──►  app
Wikidata (artist name)    ──►  download portrait image ──►  S3 (public)  ─┘
```

Both sources are pulled in the **same** daily run (`MUSEUM_SOURCES=wellcome,harvard`)
and merged before staging — every run grows the catalog from both museums.
Artist/artwork ids carry a source prefix (`wc-…`/`wellcome-artist-…` for
Wellcome, `harvard-…`/`harvard-artist-…` for Harvard), so the merged catalog is
collision-free with no dedup logic needed.

Artist portraits are resolved server-side (Wikidata) during the job, downloaded,
and stored in S3 too (`artworks/artists/…`). Their URL is saved to
`artists.avatar_url`, so the app shows portraits **with no live backend** — the
old Vercel `/api/artist-photo` endpoint is no longer used by the client.

> **Source note:** use `MUSEUM_SOURCES=wellcome,harvard` (or just `wellcome`).
> The Art Institute of Chicago (`artic`) IIIF server returns **403** to
> server-side downloads, so its images cannot be stored in S3 — don't include
> it in `MUSEUM_SOURCES` for ingestion.

---

## One-time setup on the EC2 box

SSH in (EC2 → Instances → `backend-server` → Connect), then:

```bash
# 1. Clone the repo
cd ~
git clone <your-repo-url> narsil-museum-backend
cd narsil-museum-backend

# 2. Install dependencies (full install — the job runs via tsx)
npm install

# 3. Create the environment file
cp .env.example .env
nano .env        # fill in the values below
```

Set at least these in `.env`:

```ini
MUSEUM_SOURCES=wellcome,harvard
CATALOG_LIMIT=120

# Free key from https://harvardartmuseums.org/collections/api
HARVARD_API_KEY=<paste your Harvard Art Museums API key here>

AWS_REGION=us-east-2
S3_BUCKET=narsil-backend-images
S3_PREFIX=artworks
S3_PUBLIC_BASE_URL=https://narsil-backend-images.s3.us-east-2.amazonaws.com

SUPABASE_URL=https://oocqhiojgtjrkvdsthzz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<paste the service_role secret here>
```

> AWS credentials are **not** needed here — the EC2 instance role
> (`narsil-ec2-role`) supplies them automatically.

## Run the Supabase migration (once)

In the Supabase dashboard → **SQL Editor** → run the contents of
`museum-app/supabase/catalog-columns.sql` (adds the catalog columns). Safe to
re-run.

## First run (manual)

```bash
npm run ingest
```

Expected output ends with something like:

```
4/4 Upserting into Supabase…
Done in 42.3s — 240 artworks + NN artists live.
```

Verify:

- **Supabase** → Table editor → `artworks` has rows with `image_url` set to
  `https://narsil-backend-images.s3.us-east-2.amazonaws.com/artworks/wc-….jpg`
  (Wellcome) and `…/artworks/harvard-….jpg` (Harvard).
- Open one of those URLs in a browser — the image should load.
- Open the app — the feed/search/discover screens show the museum art.

## Schedule it daily (cron)

```bash
crontab -e
```

Add (runs every day at 03:00 server time; `bash -lc` loads your PATH so
`node`/`npm` resolve):

```cron
0 3 * * * /bin/bash -lc 'cd /home/ubuntu/narsil-museum-backend && npm run ingest' >> /home/ubuntu/narsil-ingest.log 2>&1
```

Check the log after the next run: `tail -n 50 ~/narsil-ingest.log`.

---

## Updating the backend code later

```bash
cd ~/narsil-museum-backend
git pull
npm install            # only if dependencies changed
# next cron run uses the new code (nothing to restart — it's a batch job)
```

## Tuning (all optional, in `.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `MUSEUM_SOURCES` | wellcome | Comma list of sources to ingest each run, e.g. `wellcome,harvard` |
| `HARVARD_API_KEY` | — | Required when `harvard` is in `MUSEUM_SOURCES` — free key from the [Harvard API form](https://harvardartmuseums.org/collections/api) |
| `CATALOG_LIMIT` | 80 | How many artworks to ingest per run, per source |
| `HARVARD_CATALOG_LIMIT` | `CATALOG_LIMIT` | Per-run artwork limit for Harvard specifically |
| `INGEST_IMAGE_WIDTH` | 843 | Width (px) of the stored image |
| `INGEST_SKIP_EXISTING` | true | Skip images already in S3 (set `false` to re-upload) |
| `INGEST_CONCURRENCY` | 6 | Parallel downloads/uploads |
| `INGEST_ARTIST_PHOTOS` | true | Resolve + store artist portraits in S3 (`false` to skip) |
| `S3_ARTIST_PREFIX` | artworks/artists | Folder for portraits (kept public by the `artworks/*` policy) |

### Rolling back to a single source

Set `MUSEUM_SOURCES=wellcome` (or delete `MUSEUM_SOURCES` to fall back to
`MUSEUM_SOURCE`) to revert to single-source ingestion with no code changes.
Existing Harvard-sourced rows in Supabase/S3 simply stop growing — nothing is
deleted.
