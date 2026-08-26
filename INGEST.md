# Daily image ingestion — EC2 setup

The ingestion job pulls public-domain artworks from a museum API, uploads the
images to **S3** (`narsil-backend-images`), and upserts artworks + artists into
**Supabase**. The app then reads the catalog directly from Supabase and loads
images straight from S3.

```
Wellcome Collection API    ──►  download IIIF image    ──►  S3 (public)  ─┐
The Met (Open Access) API  ──►  download image URL     ──►  S3 (public)  ─┤
Cleveland (Open Access)    ──►  download CDN image     ──►  S3 (public)  ─┤
Rijksmuseum Data Services  ──►  download IIIF image    ──►  S3 (public)  ─┼─►  Supabase rows  ──►  app
Flickr Commons (LoC + BL)  ──►  download CDN image     ──►  S3 (public)  ─┤
Art Institute of Chicago   ──►  (image HOTLINKED — metadata only)        ─┘
```

A **second daily cron** (`npm run ingest:artists`) builds For You artist
profiles from **museum / IIIF catalog data only** (no Wikipedia): real person
photo on the artist row + museum bio + collection titles. Only artists with
`profile_ready = true` appear as story cards.

All listed sources are pulled in the **same** daily run (e.g.
`MUSEUM_SOURCES=wellcome,met,cma,rijks`) and merged before staging — every run
grows the catalog from every museum listed. Artist/artwork ids carry a source
prefix (`wc-…`/`wellcome-artist-…`, `met-…`, `cma-…`, `rijks-…`), so the merged
catalog is collision-free with no dedup logic needed.

The Met and the Cleveland Museum of Art are **CC0 (public domain)** and need
**no API key**; re-hosting their images to S3 and storing rows permanently is
explicitly allowed and safe for commercial use. The Rijksmuseum source (also
key-free, built on the new `data.rijksmuseum.nl` Data Services — not the
deprecated legacy API) ingests **only** works whose image carries a Creative
Commons public-domain mark, so the same applies.

Artist portraits from Wikidata are **not** used. For You artist cards are built
by `npm run ingest:artists` from museum/IIIF catalog fields only (`avatar_url`,
museum bio, collection works).

> **Source note:** use any mix of `wellcome`, `met`, `cma`, `rijks`, `flickr`,
> `artic`.
>
> - `flickr` (Library of Congress + British Library via Flickr Commons) needs
>   the free `FLICKR_API_KEY` in `.env`; while it's unset the source is
>   skipped with a notice, so it's safe to list ahead of getting the key.
> - `artic` images are **hotlinked**, not stored in S3: the AIC IIIF server
>   returns 403 to every non-browser client (verified), so the raw
>   `www.artic.edu` image URL is stored and the browser loads it directly.
>   Include it only if you accept those images living on AIC's servers.

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
MUSEUM_SOURCES=wellcome,met,cma,rijks
CATALOG_LIMIT=50

# The Met, Cleveland (cma) and Rijksmuseum (rijks) need no API key (CC0 /
# public-domain, key-free). CATALOG_LIMIT is PER SOURCE — four sources at 50
# ingest ~200 artworks per run (~125s).

AWS_REGION=us-east-2
S3_BUCKET=narsil-backend-images
S3_PREFIX=artworks
S3_PUBLIC_BASE_URL=https://narsil-backend-images.s3.us-east-2.amazonaws.com

SUPABASE_URL=https://oocqhiojgtjrkvdsthzz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<paste the service_role secret here>
```

> AWS credentials are **not** needed here — the EC2 instance role
> (`narsil-ec2-role`) supplies them automatically.

> **Keep exactly one `MUSEUM_SOURCES` line.** dotenv lets the LAST duplicate key
> in the file win, so a leftover `MUSEUM_SOURCES=` further down silently
> overrides the one you just edited — `.env` reads correctly while the job
> ingests something else. Verify with
> `grep -n "^[^#]*MUSEUM_SOURCE" .env`; it must print a single line. The
> `Ingest: sources=…` line at the top of every run is the ground truth.

## Run the Supabase migrations (once)

In the Supabase dashboard → **SQL Editor** → run:

1. `museum-app/supabase/catalog-columns.sql` (catalog fields)
2. `museum-app/supabase/artist-wiki-columns.sql` (famous works + `profile_ready`)

Both are safe to re-run.

## First run (manual)

```bash
npm run ingest
```

Expected output ends with something like:

```
4/4 Upserting into Supabase…
Done in 125.3s — 200 artworks + 103 artists live.
```

Verify:

- **Supabase** → Table editor → `artworks` has rows with `image_url` set to
  `https://narsil-backend-images.s3.us-east-2.amazonaws.com/artworks/wc-….jpg`
  (Wellcome) and `…/artworks/met-….jpg` (The Met).
- Open one of those URLs in a browser — the image should load.
- Open the app — the feed/search/discover screens show the museum art.

## S3 CORS (Capacitor / Vercel)

The iOS app (WKWebView) and the Vercel site `fetch` feed images for the Cache
API. `<img>` works without CORS; those fetches need
`Access-Control-Allow-Origin` on the bucket.

Apply the policy in `s3-cors.json` (from a machine with AWS CLI + rights on
`narsil-backend-images`):

```bash
aws s3api put-bucket-cors \
  --bucket narsil-backend-images \
  --cors-configuration file://s3-cors.json
```

Or paste the same `CORSRules` into S3 → bucket → Permissions → CORS. Add any
extra Vercel preview origins you use. The app also caches via wsrv.nl when S3
CORS is missing, so display still works either way.

## Schedule it daily (cron)

```bash
crontab -e
```

Add (runs every day at 03:00 server time; `bash -lc` loads your PATH so
`node`/`npm` resolve). The `date -Is` stamp opens each run — without it the
appended runs are indistinguishable and you cannot tell last night's output from
last month's:

```cron
0 3 * * * /bin/bash -lc 'cd ~/narsil-museum-backend && echo "=== $(date -Is) ===" && npm run ingest' >> ~/ingest-cron.log 2>&1
30 4 * * * /bin/bash -lc 'cd ~/narsil-museum-backend && echo "=== $(date -Is) artist-profiles ===" && npm run ingest:artists:prod' >> ~/artist-profiles-cron.log 2>&1
```

> Avoid `%` anywhere in a crontab command — cron turns it into a newline.
> `date -Is` sidesteps that; `date +%F` would break the line.

### Artist profile cron (For You story cards)

Artwork ingest (IIIF / museum APIs) grows the catalog. The **artist profile**
job builds cards from **museum data only — no Wikipedia / Wikidata**:

```
Museum / IIIF artworks in Supabase  ──►  collection titles + museum bio  ─┐
Museum / catalog artist avatar_url  ──►  person photo (required)         ─┼─►  profile_ready
```

Rules:

- **No museum person photograph → no card.**
- **No rich museum bio → no card.**
- Frontend only shows artist story slides when `profile_ready = true`.

One-time SQL (Supabase → SQL Editor):

```text
museum-app/supabase/artist-wiki-columns.sql
```

Manual run on EC2:

```bash
cd ~/narsil-museum-backend
npm run build
npm run ingest:artists:prod -- --limit=40
# dry-run:
# npm run ingest:artists -- --dry-run --limit=10
```

Check the log: `tail -n 80 ~/artist-profiles-cron.log`.

Rotate that log too:

```bash
sudo tee /etc/logrotate.d/narsil-artist-profiles > /dev/null <<'EOF'
/home/ubuntu/artist-profiles-cron.log {
  weekly
  rotate 8
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su ubuntu ubuntu
}
EOF
```

Confirm cron fired it at all (Ubuntu logs every invocation to syslog):

```bash
grep CRON /var/log/syslog | grep narsil
```

### Rotate the log (once)

The cron line appends forever. Without rotation the file grows unbounded and old
failures linger at the top looking current:

```bash
sudo tee /etc/logrotate.d/narsil-ingest > /dev/null <<'EOF'
/home/ubuntu/ingest-cron.log {
  weekly
  rotate 8
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su ubuntu ubuntu
}
EOF

sudo logrotate -d /etc/logrotate.d/narsil-ingest   # dry run; drop -d to apply
```

---

## Updating the backend code later

```bash
cd ~/narsil-museum-backend
git pull
npm install            # only if dependencies changed
# next cron run uses the new code (nothing to restart — it's a batch job)
```

### One-time cleanup after the artist-name hygiene change

Artist ids derive from the display name, so the first ingest after the
name-cleanup update (`src/museum/artistName.ts`) re-points artworks to
freshly-named artist rows. Remove the orphaned garbled ones ("? Thiery",
"a painting", …) by running `museum-app/supabase/cleanup-orphan-artists.sql`
once in the Supabase SQL Editor after that ingest completes.

## Tuning (all optional, in `.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `MUSEUM_SOURCES` | wellcome | Comma list of sources to ingest each run, e.g. `wellcome,met` |
| `CATALOG_LIMIT` | 80 | How many artworks to ingest per run, per source |
| `INGEST_IMAGE_WIDTH` | 843 | Width (px) of the stored image |
| `INGEST_SKIP_EXISTING` | true | Skip images already in S3 (set `false` to re-upload) |
| `INGEST_CONCURRENCY` | 6 | Parallel downloads/uploads |
| `S3_ARTIST_PREFIX` | artworks/artists | Legacy portrait folder (Wikidata portraits disabled) |
| Artist profile cron | `npm run ingest:artists` | Museum/IIIF only → `profile_ready` |

### Rolling back to a single source

Set `MUSEUM_SOURCES=wellcome` (or delete `MUSEUM_SOURCES` to fall back to
`MUSEUM_SOURCE`) to revert to single-source ingestion with no code changes.
Existing Met-sourced rows in Supabase/S3 simply stop growing — nothing is
deleted.
