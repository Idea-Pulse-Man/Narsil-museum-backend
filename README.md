# narsil-museum-backend

The API server for the **Narsil** app ([museum-app](https://github.com/Idea-Pulse-Man/Narsil-app-frontend)).
It does four jobs:

1. **Catalog.** A daily ingest job pulls public-domain art from six museum APIs, stores the images in S3 and upserts the works into Supabase. The app reads the catalog straight from Supabase; this server adds image delivery, downloads and single-artwork lookups.
2. **Canvas checkout.** It prices orders, takes payment through Stripe and sends paid orders to Printful for printing (US addresses only). Printful's webhook reports shipping back.
3. **Narsil Pro.** It verifies Apple in-app purchases and serves subscription status.
4. **Quiz, notifications and sharing.** Nightly jobs write the daily Royal Assessment and generate questions for every question style switched on in the admin (the question engine, `src/quiz/`). Other jobs send daily quiz and streak push notifications, and `/share/:id` serves link-preview pages.

Built with Node.js 22, Express and TypeScript.

**More docs:** [INGEST.md](INGEST.md) (cron jobs on EC2) · [docs/runbook.md](docs/runbook.md) (deploy, logs, fixing production) · [docs/quiz-engine.md](docs/quiz-engine.md) (question engine, adding a style) · [CHANGELOG.md](CHANGELOG.md)

## Quick start

```bash
npm install
cp .env.example .env   # fill in what you need, see Configuration
npm run dev            # http://localhost:4000
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Deletes `dist/` and compiles to `dist/` |
| `npm start` | Runs the compiled build |
| `npm run typecheck` | Type-checks source and tests |
| `npm test` | Unit tests (Vitest) |
| `npm run deploy` | **On EC2:** pull, clean install, build, restart pm2 |
| `npm run ingest` | Daily catalog import (see [INGEST.md](INGEST.md)) |
| `npm run ingest:artists` | Daily artist-profile cards (Wikidata) |
| `npm run quiz:daily` | Writes the shared daily Royal Assessment (classic, for app versions without the question engine) |
| `npm run quiz:generate` | Question engine: builds questions for every style switched on in the admin, fills the daily mix (`--dry-run`, `--style=a,b`, `--count=N`, `--no-daily`, `--date=YYYY-MM-DD`) |
| `npm run push:daily -- --quiz` / `--streak` | Daily quiz and streak-at-risk notifications |
| `npm run backfill:descriptions` | Repairs and AI-describes existing rows (`--dry-run`, `--skip-ai`, `--ai-limit=N`) |

Every job script has a `:prod` variant (`ingest:prod`, `quiz:generate:prod`, `push:daily:prod`…) that runs the compiled `dist/` build. Cron uses those; the schedule is in [INGEST.md](INGEST.md#schedule-it-daily-cron).

## API

All routes live under `/api`. Every client gets 600 requests per minute; stricter limits are noted below.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | none | Health check |
| GET | `/artworks` | none | Live catalog cache → `{ data, total }` |
| GET | `/artworks/:id` | none | One artwork (cache, then Supabase) |
| GET | `/artworks/:id/download` | optional | Streams the image. `?res=standard` (2000px, free) or `?res=high` (master, Pro only). Limited to 30 per 10 min |
| GET | `/artists`, `/artists/:id` | none | Artists |
| GET | `/artist-photo?name=` | none | Wikidata portrait lookup. Limited to 60 per min |
| GET | `/image/:identifier` | none | IIIF image proxy (`?w=`, `?full=1`), see [Image delivery](#image-delivery) |
| GET | `/prices` | none | Canvas + poster price tables the app displays (from `services/pricing.ts`) |
| POST | `/telemetry` | none | Anonymous usage events and app errors (120 batches / 10 min) |
| POST | `/checkout/payment-intent` | user | Prices the order and creates the Stripe PaymentIntent |
| POST | `/checkout/orders/:id/finalize` | user | Verifies the payment, then submits to Printful |
| GET | `/checkout/orders/:id` | user | Order status |
| POST | `/stripe/webhook` | Stripe signature | `payment_intent.succeeded` → same finalize step |
| POST | `/printful/webhook?secret=` | shared secret | Shipped, cancelled and failed updates, each confirmed with Printful's API |
| POST | `/apple/verify` | user | Verifies an App Store transaction |
| POST | `/apple/notifications` | Apple signature | App Store Server Notifications v2 |
| GET | `/me/subscription` | user | Narsil Pro status |
| POST | `/me/delete` | user | Permanently deletes the account (orders kept, anonymous) |
| POST | `/admin/orders/:id/retry` | admin | Retries a failed Printful submission |
| GET | `/admin/orders/:id` | admin | Order detail |
| POST | `/admin/quiz/generate` | admin | AI-generated quiz questions |
| GET | `/admin/quiz/engine/styles` | admin | Question-style registry (drives the admin settings forms) |
| POST | `/admin/quiz/engine/preview` | admin | Sample questions for one style + settings, nothing saved |
| POST | `/admin/quiz/engine/run` | admin | "Generate now": every enabled style, or `{ style, count }`; also tops up today's daily mix |
| GET | `/admin/quiz/engine/runs` | admin | Generator run history |
| GET | `/admin/printful/drafts` | admin | Paid orders waiting to be confirmed in Printful |
| POST | `/refresh` | admin | Drops the catalog cache |

Outside `/api`:

| Method | Path | Description |
|---|---|---|
| GET | `/share/:id` | Shareable artwork page: picture preview for WhatsApp/iMessage, then forwards to the web app |
| GET | `/.well-known/apple-app-site-association` | Lets the iPhone app open `/share/*` links (needs `APPLE_TEAM_ID`) |

"User" means a Supabase access token in `Authorization: Bearer …`. "Admin" also requires `profiles.role = 'admin'`.

## Money rules (read before changing checkout)

- **Prices are set in one place:** [src/services/pricing.ts](src/services/pricing.ts). Checkout charges from it, and the app displays it via `GET /api/prices`. Canvas costs were verified against Printful quotes on 2026-09-28.
- **Two products:** canvas ($59 / $89 / $129) and poster ($29 / $35 / $45), in the same three sizes. **Poster shipping is an estimate.** Confirm it with the estimate-costs check (variant ids 1349 / 1 / 2) and correct `landedCost` if it differs.
- **Artist originals** are canvas only. Their Small canvas is $69, because at $59 the artist's 30% left Narsil about $2.50.
- **Only fully paid orders reach Printful.** The server checks with Stripe that the PaymentIntent succeeded, belongs to that order and received the full price.
- **Orders arrive in Printful as drafts** while `PRINTFUL_CONFIRM_ORDERS=false`. Someone confirms each one in the Printful dashboard (Orders).
- **US addresses only** ([src/services/recipient.ts](src/services/recipient.ts)).
- **Artist share is capped at 30%** (`MAX_ARTIST_SHARE_PCT`). At a higher share, small canvases lose money.
- Every fulfilled order logs a `[margin]` line with Printful's real bill and stores it in `canvas_orders.printful_cost`.

## Production

| Part | Where |
|---|---|
| Server | EC2 (us-east-2), Node on port 4000 under pm2 as `narsil-backend` |
| HTTPS | CloudFront `https://d2lvgalchu2nps.cloudfront.net`, with no nginx in between |
| Firewall | Port 4000 only accepts CloudFront (prefix list `pl-b6a144df`) |
| Database | Supabase (setup order in `museum-app/supabase/README.md`) |
| Images | S3 bucket `narsil-backend-images` |
| Crons | Ingest, artist profiles, daily quiz and the question engine; see [INGEST.md](INGEST.md#schedule-it-daily-cron) |

CloudFront must allow **POST**, use **CachingDisabled**, and use the **AllViewer** origin request
policy. Otherwise the `Authorization` and `Stripe-Signature` headers are dropped and payments
break. `TRUST_PROXY=1` (the default) makes rate limits use the visitor's IP rather than
CloudFront's.

**Deploying:** on the server, run `cd ~/narsil-museum-backend && npm run deploy`. A plain `git pull` is
not enough, because pm2 runs the compiled `dist/`. Rollback, health checks, log locations and fixes for
common failures are in [docs/runbook.md](docs/runbook.md).

**Reminder:** the Printful API token (`PRINTFUL_API_KEY`, "Narsil-printful") expires on
**2027-01-23**. Replace it before then (scopes: Orders, Orders/read), or every canvas order fails.

GitHub Actions runs type-check, tests and build on every push to `main` (`.github/workflows/ci.yml`).

## Configuration

All settings are environment variables. [.env.example](.env.example) documents each one.

| Group | Variables |
|---|---|
| Server | `PORT`, `NODE_ENV`, `CORS_ORIGIN` (extra origins; the app's own are built in), `TRUST_PROXY`, `PUBLIC_BASE_URL` (falls back to Vercel's `VERCEL_URL`) |
| Catalog | `MUSEUM_SOURCES` (`wellcome,artic,met,cma,rijks,flickr`; the older singular `MUSEUM_SOURCE` still works), `MUSEUM_API_BASE_URL`, `IIIF_BASE_URL`, `IMAGE_DELIVERY`, `IIIF_IMAGE_WIDTH`, `CATALOG_LIMIT`, `CATALOG_CACHE_TTL_MS`, `FLICKR_API_KEY`, `FLICKR_ACCOUNTS` |
| Ingest | `AWS_REGION`, `S3_BUCKET`, `S3_PREFIX`, `S3_ARTIST_PREFIX`, `S3_PUBLIC_BASE_URL`, `INGEST_IMAGE_WIDTH`, `INGEST_SKIP_EXISTING`, `INGEST_CONCURRENCY` |
| AI | `OPENAI_API_KEY`, `OPENAI_MODEL` (default `gpt-5.5`) |
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Stripe | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CHECKOUT_CURRENCY` |
| Printful | `PRINTFUL_API_KEY`, `PRINTFUL_STORE_ID`, `PRINTFUL_WEBHOOK_SECRET`, `PRINTFUL_CONFIRM_ORDERS`, `PRINTFUL_CANVAS_PRODUCT_ID`, `PRINTFUL_VARIANT_SMALL` / `_MEDIUM` / `_LARGE` |
| Apple | `APPLE_PRIVATE_KEY`, `APPLE_KEY_ID`, `APPLE_ISSUER_ID`, `APPLE_BUNDLE_ID`, `APPLE_APP_APPLE_ID`, `APPLE_ENVIRONMENT`, `APPLE_ROOT_CA_DIR`, `APPLE_PRODUCT_IDS` |
| Push + links | `APNS_KEY`, `APNS_KEY_ID`, `APPLE_TEAM_ID`, `APNS_ENVIRONMENT`, `WEB_APP_URL` |
| Posters | `PRINTFUL_POSTER_PRODUCT_ID` (default 1) |

On EC2, AWS credentials come from the instance role. Never put AWS access keys in `.env`.

## Image delivery

Images come from IIIF Image API 3.0 servers or from the S3 copies made at ingest. With
`IMAGE_DELIVERY=proxy` (the default), `/api/image/:identifier` streams the image through this
server so the app loads it from one origin. If a museum's image server refuses server-side
requests (the Art Institute of Chicago's WAF does), the route redirects the browser to the
direct IIIF URL instead, and remembers that host. `IMAGE_DELIVERY=direct` always hands out the
raw IIIF URL.

## Project structure

```
src/
├── index.ts, app.ts       # Boot + Express app (CORS, rate limits, routes)
├── config/env.ts          # Typed environment configuration
├── middleware/            # auth (user/admin), rateLimit, 404, errors
├── routes/                # One file per /api area (see API table)
├── services/              # checkout, pricing, printful, recipient, stripe,
│                          # appleStore, subscriptions, sellability, quizGenerate (AI),
│                          # push, telemetry, accountDeletion, supabaseAdmin
├── museum/                # Museum sources (wellcome, artic, met, cma, rijks,
│                          # flickr), IIIF, taxonomy, live catalog cache
├── ingest/                # Daily jobs: run (catalog), artistProfiles,
│                          # enrichArtistWiki, dailyQuiz, quizGenerate, pushDaily,
│                          # backfillDescriptions, aiDescription (+ s3, store helpers)
├── quiz/                  # Question engine: catalog loader, 27 style builders
│                          # (styles/), validator, scoring, generate (cron + admin);
│                          # guide in docs/quiz-engine.md
├── types/domain.ts        # Artwork / Artist (mirror the app's types)
└── utils/                 # http, cache, wall text, image download helpers
```

Tests sit next to the code they cover (`*.test.ts`).
