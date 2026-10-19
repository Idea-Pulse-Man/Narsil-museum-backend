# Changelog

Notable changes to the Narsil backend, newest first. Dates are commit dates.
The full history is in `git log`.

## 2026-10-19 — Quiz question engine

- New `src/quiz/`: 27 question styles (classic plus pick the image, select
  all, odd one out, find the pair, placard match, detail match, zoom / blur /
  tile reveal, real or mirrored, intruder tile, missing piece, timeline, match
  pairs, match to period, sort into groups, year slider, before or after,
  older or newer, more loved, true or false, two truths and a lie, fill the
  title, type the artist, unscramble, clue ladder). Every question is
  validated and de-duplicated before it is saved.
- New cron `npm run quiz:generate:prod` (00:10 UTC) fills `quiz_items` and the
  daily `daily_quiz_items` for every style switched on in the admin.
- New admin routes `GET /api/admin/quiz/engine/styles`, `POST …/preview`,
  `POST …/run`, `GET …/runs`.
- Needs `museum-app/supabase/quiz-engine.sql`. See
  [docs/quiz-engine.md](docs/quiz-engine.md).
- Docs: README, INGEST (all cron jobs in one table, `npm run deploy` for
  updates), new runbook and this changelog.

## 2026-10-07 — Accounts, alerts, push, sharing, posters

- Account deletion (`POST /api/me/delete`); orders are kept, anonymised.
- Admin alert for paid orders waiting as Printful drafts
  (`GET /api/admin/printful/drafts`).
- Anonymous telemetry (`POST /api/telemetry`).
- iOS push notifications: daily quiz and streak reminders (`push:daily`),
  "your print has shipped", "new paid order" for admins.
- Share pages `/share/:id` with link previews, and Universal Links via
  `/.well-known/apple-app-site-association`.
- Posters ($29 / $35 / $45) alongside canvas.

## 2026-10-02 — Tests and CI

- Unit tests (Vitest) and GitHub Actions CI on `main`; `dist/` is cleaned on
  every build. README rewritten for the current system.

## 2026-09-24 → 2026-10-01 — Daily quiz and checkout hardening

- Daily cron writes the shared Royal Assessment (`quiz:daily`).
- Canvas orders: US addresses only; only fully paid orders reach Printful;
  verified Printful costs recorded; artist share capped at 30%.
- Locked down `/refresh`, CORS and the Printful webhook; added rate limits;
  image proxy streams bytes.
- New artworks are described at ingest; canvas prices served from
  `GET /api/prices`; artwork detail falls back to Supabase.

## 2026-09-03 → 2026-09-23 — Pricing and sellability

- Canvas repriced to $59 / $89 / $129; the 20% subscriber discount removed.
- Admin AI quiz generation (`POST /api/admin/quiz/generate`).
- Pots, sculptures, crafts and 3D pieces are rejected for canvas at checkout
  and at ingest.

## 2026-08 — Artist cards and downloads

- Artist profile cron fills up to 50 ready For You artist cards a day
  (museum data first, Wikimedia politely rate-limited) into `fyp_artist_cards`.
- Artwork downloads stream instead of buffering; S3 CORS documented.

## 2026-07 — Foundations

- **Pro:** Apple subscription entitlement, App Store verification and
  notifications (2026-07-29).
- **Checkout:** Stripe payment → Printful fulfilment, Printful status webhook,
  admin order routes (2026-07-15 → 07-27).
- **Descriptions:** tiered placard pipeline — wall text, backfill, gated AI.
- **Sources:** Wellcome, then The Met (CC0), Cleveland, Rijksmuseum, Flickr
  Commons and Art Institute of Chicago hotlinking; shared artist-name hygiene.
- **Ingest:** daily S3 + Supabase job; the live catalog is served from
  Supabase (2026-07-06 → 07-14).
- Initial IIIF image API server (2026-07-01).
