# Configuration reference

Every environment variable the backend reads, with its default and what
happens when it is missing. Source of truth: [src/config/env.ts](../src/config/env.ts).
The annotated template is [.env.example](../.env.example).

- Put values in `.env` on the EC2 box. After editing, run
  `pm2 restart narsil-backend --update-env` (the cron jobs read `.env` on
  every run by themselves).
- Multi-line keys (`APPLE_PRIVATE_KEY`, `APNS_KEY`) go on one line with `\n`
  for each line break, in double quotes.
- **dotenv keeps the last duplicate.** A key written twice silently uses the
  lower one — check with `grep -n "^[^#]*KEY_NAME" .env`.
- AWS credentials are **never** in `.env`; on EC2 they come from the instance
  role `narsil-ec2-role`.

## Server

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | CloudFront's origin points at this port |
| `NODE_ENV` | `development` | Set `production` on EC2 |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:3000` | Extra allowed origins (comma list). The Vercel app, `capacitor://localhost` and `https://localhost` are always allowed |
| `TRUST_PROXY` | `1` | Proxies in front of the app (CloudFront = 1). Rate limits key on the visitor IP only when this is right. Use `0` with nothing in front |
| `PUBLIC_BASE_URL` | `https://$VERCEL_URL`, else `http://localhost:$PORT` | Public address of this API, used in links it hands out |
| `WEB_APP_URL` | `https://narsil-app-frontend.vercel.app` | Where `/share/:id` pages forward to |

## Catalog and images

| Variable | Default | Notes |
|---|---|---|
| `MUSEUM_SOURCES` | `wellcome` | Comma list from `wellcome, artic, met, cma, rijks, flickr`. Unknown names are ignored; if none are valid it falls back to `wellcome` with a warning |
| `MUSEUM_SOURCE` | — | Older single-source name, read only when `MUSEUM_SOURCES` is unset |
| `MUSEUM_API_BASE_URL` | the first source's API | Override only for testing |
| `IIIF_BASE_URL` | the first source's IIIF server | Override only for testing |
| `IMAGE_DELIVERY` | `proxy` | `proxy` streams images through `/api/image`; `direct` hands out the raw IIIF URL |
| `IIIF_IMAGE_WIDTH` | `800` | Width requested from IIIF servers for display |
| `CATALOG_LIMIT` | `80` | Artworks per source per ingest run |
| `CATALOG_CACHE_TTL_MS` | `3600000` (1 h) | Lifetime of the in-memory catalog cache behind `/api/artworks` |
| `FLICKR_API_KEY` | — | While unset the `flickr` source is skipped with a notice |
| `FLICKR_ACCOUNTS` | built-in list | Flickr Commons accounts to pull from |

## Ingest (S3)

| Variable | Default | Notes |
|---|---|---|
| `AWS_REGION` | `us-east-2` | |
| `S3_BUCKET` | — | **Required** for ingest (`narsil-backend-images`) |
| `S3_PREFIX` | `artworks` | Folder for artwork images (must be public) |
| `S3_ARTIST_PREFIX` | `artworks/artists` | Legacy portrait folder |
| `S3_PUBLIC_BASE_URL` | — | Public URL of the bucket, stored in `artworks.image_url` |
| `INGEST_IMAGE_WIDTH` | `843` | Width of the stored image |
| `INGEST_SKIP_EXISTING` | `true` | `false` re-uploads images already in S3 |
| `INGEST_CONCURRENCY` | `6` | Parallel downloads / uploads |

## Supabase

| Variable | Default | Notes |
|---|---|---|
| `SUPABASE_URL` | — | **Required** for almost everything |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Server only** — bypasses RLS. Routes that need it answer 503 while it's unset; jobs exit with an error |

## AI descriptions

| Variable | Default | Notes |
|---|---|---|
| `OPENAI_API_KEY` | — | While unset, AI placards and admin AI quiz generation are skipped (the admin route answers 400) |
| `OPENAI_MODEL` | `gpt-5.5` | |

## Stripe

| Variable | Default | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | — | `sk_test_…` / `sk_live_…`. Checkout routes answer 503 while unset |
| `STRIPE_WEBHOOK_SECRET` | — | `whsec_…` for `/api/stripe/webhook` |
| `CHECKOUT_CURRENCY` | `usd` | |

## Printful

| Variable | Default | Notes |
|---|---|---|
| `PRINTFUL_API_KEY` | — | Private token. **Expires 2027-01-23** (scopes Orders, Orders/read) |
| `PRINTFUL_STORE_ID` | — | Needed when the token can see more than one store |
| `PRINTFUL_WEBHOOK_SECRET` | — | Shared secret in the webhook URL (`?secret=`) |
| `PRINTFUL_CONFIRM_ORDERS` | `false` | `false` = paid orders arrive as **drafts** to confirm by hand; `true` = Printful charges and prints straight away |
| `PRINTFUL_CANVAS_PRODUCT_ID` | `3` | "Canvas (in)" |
| `PRINTFUL_POSTER_PRODUCT_ID` | `1` | "Enhanced Matte Paper Poster (in)" |
| `PRINTFUL_VARIANT_SMALL` / `_MEDIUM` / `_LARGE` | looked up | Pin the canvas variant ids instead of resolving them from the catalog |

## Apple — subscriptions

| Variable | Default | Notes |
|---|---|---|
| `APPLE_PRIVATE_KEY` | — | App Store Connect API key (`.p8`, In-App Purchase role) |
| `APPLE_KEY_ID` | — | |
| `APPLE_ISSUER_ID` | — | |
| `APPLE_BUNDLE_ID` | `com.narsil.museum` | Must match the app exactly |
| `APPLE_APP_APPLE_ID` | — | Numeric App ID (App Store Connect → App Information) |
| `APPLE_ENVIRONMENT` | `Production` | `Sandbox` for TestFlight / simulator builds. A transaction from the other environment is rejected |
| `APPLE_ROOT_CA_DIR` | `certs/apple` | Apple Root CA - G3 (`.cer`). Without it nothing can be verified |
| `APPLE_PRODUCT_IDS` | `com.narsil.museum.pro.monthly,com.narsil.museum.pro.annual` | Must match `PRO_MONTHLY` / `PRO_ANNUAL` in the app |

While any of the first five is missing, the whole subscription tier no-ops and
nobody is a subscriber.

## Apple — push and links

| Variable | Default | Notes |
|---|---|---|
| `APNS_KEY` | — | APNs auth key (`.p8`). Push jobs skip quietly while unset |
| `APNS_KEY_ID` | — | |
| `APPLE_TEAM_ID` | — | Also turns on `/.well-known/apple-app-site-association` (Universal Links) |
| `APNS_ENVIRONMENT` | production | `sandbox` only for builds run straight from Xcode |

## Not settings

- The **question engine** has no `.env` settings. Styles, counts, the daily
  size and the practice mix are set in the app's admin **Question styles**
  panel (`quiz_styles`, `quiz_engine_config`).
- `INGEST_ARTIST_PHOTOS` still appears in `.env.example` but no code reads it.
