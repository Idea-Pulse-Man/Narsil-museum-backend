# Production runbook

What to do on the EC2 box when deploying, checking health, or fixing
something. Setup from scratch is in [README.md](../README.md#production) and
[INGEST.md](../INGEST.md); this page is the day-to-day checklist.

Connect: EC2 → Instances → `backend-server` → Connect, then
`cd ~/narsil-museum-backend`.

## Deploy

```bash
npm run deploy     # git pull --ff-only, npm ci, build dist/, pm2 restart narsil-backend
```

- A plain `git pull` is not enough — the API and the `:prod` cron jobs run the
  compiled `dist/`.
- After changing `.env`: `pm2 restart narsil-backend --update-env`
  (without `--update-env` pm2 keeps the old values).
- If a deploy adds a Supabase SQL file, run it in the SQL Editor **before**
  deploying (order: `museum-app/supabase/README.md`).

## Roll back

```bash
git log --oneline -10                 # find the last good commit
git checkout <good-sha>
npm ci && npm run build && pm2 restart narsil-backend
```

This leaves the checkout detached. Once the fix is pushed:
`git checkout main && npm run deploy`.

## Is it healthy?

| Check | Command / place | Good |
|---|---|---|
| API up | `curl -s https://d2lvgalchu2nps.cloudfront.net/api/health` | `{"status":"ok",…}` |
| Process | `pm2 status` | `narsil-backend` online, restarts not climbing |
| API logs | `pm2 logs narsil-backend --lines 100` | no repeating errors |
| Crons fired | `grep CRON /var/log/syslog \| grep narsil` | one line per job per day |
| Prices served | `curl -s …/api/prices` | canvas + poster tables |

## Logs

| Job | Log |
|---|---|
| Artwork ingest (03:00 UTC) | `~/ingest-cron.log` |
| Artist profiles (06:00) | `~/artist-profiles-cron.log` |
| Question engine (00:10) | `~/quiz-generate-cron.log` |
| Daily quiz, classic (00:15) | `~/daily-quiz-cron.log` |
| Push quiz (13:00) / streak (00:00) | `~/push-cron.log` |
| API | `pm2 logs narsil-backend` |

Each cron run starts with a `=== <timestamp> <job> ===` line, so
`tail -n 80 <log>` shows the latest run.

## When something breaks

| Symptom | Check | Fix |
|---|---|---|
| App can't load anything / every request fails | `api/health` through CloudFront | `pm2 status`; if errored, `pm2 logs` for the crash, fix `.env`, `pm2 restart narsil-backend --update-env` |
| Payments fail or webhooks 401 | CloudFront behaviour settings | Must allow **POST**, use **CachingDisabled** and the **AllViewer** origin request policy, or `Authorization` / `Stripe-Signature` are dropped |
| Paid order never printed | Admin → Orders; Printful → Orders | With `PRINTFUL_CONFIRM_ORDERS=false` orders wait as **drafts** — confirm them in Printful. A `fulfillment_failed` order: Admin → Retry (`POST /api/admin/orders/:id/retry`) |
| Every canvas order fails at Printful | `pm2 logs` for 401 from Printful | The Printful token (`PRINTFUL_API_KEY`) expires **2027-01-23** — create a new one (scopes Orders, Orders/read), update `.env`, restart with `--update-env` |
| Pro purchases don't unlock | `pm2 logs` around `/api/apple/verify` | All `APPLE_*` vars set and `certs/apple/` holds Apple's root CA; `APPLE_ENVIRONMENT` matches the build (Sandbox for TestFlight) |
| No push notifications | `~/push-cron.log` | Jobs skip quietly until `APNS_KEY`, `APNS_KEY_ID`, `APPLE_TEAM_ID` are set |
| Feed stops growing | `~/ingest-cron.log` | Look for a source failing; `grep -n "^[^#]*MUSEUM_SOURCE" .env` must print **one** line (the last duplicate wins) |
| No new quiz questions / daily edition empty | `~/quiz-generate-cron.log`, Admin → Question styles → run history | See [quiz-engine.md → Troubleshooting](quiz-engine.md#troubleshooting) |
| Stale behaviour after a deploy | `ls -la dist/src/index.js` timestamp | Rebuild: `npm run deploy` |

## Calendar

- **2027-01-23** — Printful API token expires.
- **Yearly** — Apple's App Store Connect API key and APNs key don't expire,
  but re-check that the Paid Applications agreement is still active.
- **Weekly** — logrotate rotates the cron logs (see INGEST.md "Rotate the log").
