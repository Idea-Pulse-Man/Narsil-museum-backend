# Quiz question engine — developer guide

How `src/quiz/` turns the artwork catalog into quiz questions, and how to add a
new question style. The product plan and the QA checklist live in the app repo:
`museum-app/docs/quiz-question-engine.plan.md` and `…/quiz-question-engine.QA.md`.

## How it fits together

```
quiz_styles (admin switches) ──┐
                               ├─► runGeneration ─► build ─► validate ─► quiz_items
artworks + artists (Supabase) ─┘        │                                    │
                                        └─► fillDailyEdition ─► daily_quiz_items
                                                                             │
                                            app: daily_quiz_edition / next_quiz_items RPCs
```

- **Who runs it:** the cron (`npm run quiz:generate:prod`, 00:10 UTC — see
  [INGEST.md](../INGEST.md)) and the admin **Generate now** button
  (`POST /api/admin/quiz/engine/run`). Both call `runGeneration` in
  [src/quiz/generate.ts](../src/quiz/generate.ts).
- **What it reads:** every row in `quiz_styles` with `enabled = true` (or the
  styles named with `--style=` / `{ style }`, even if switched off), plus the
  whole visible catalog.
- **What it writes:** new rows in `quiz_items` (status `live`, or `review` when
  the style has "review before live" on), today's `daily_quiz_items`, and one
  `quiz_generation_runs` row per run.
- Tables, RLS and RPCs: `museum-app/supabase/quiz-engine.sql`.

## Files

| File | Job |
|---|---|
| `types.ts` | The generic question format (`QuizItemDraft`) and settings-field types. **Mirrored** in `museum-app/src/lib/quiz/engine/types.ts` — change both. |
| `catalog.ts` | Loads artworks + artists into flat `QuizArt` records: artist name resolved, generic makers ("Workshop of…") blanked, year parsed (`parseYear`), hidden works skipped. |
| `random.ts` | Seeded RNG (`mulberry32`), `shuffle`, `pick`, `randInt`. |
| `styles/shared.ts` | `StyleBuilder` interface, settings readers (`num`, `str`, `list`), field helpers (`fieldValue`, `isPhrase`, `distractorsFor`, `tileCrop`…). |
| `styles/*.ts` | The 27 builders, grouped: `classic`, `choice` (image answers), `visual` (crops, reveals, tiles), `ordering`, `numbers`, `words`. |
| `styles/index.ts` | The registry (`STYLE_BUILDERS`, `STYLE_BY_ID`, `describeStyles`). |
| `validate.ts` | `validateItem` (rejects broken questions) and `fingerprint` (de-duplication key). |
| `scoring.ts` | Scoring per answer type. **Mirrored** in the app's `lib/quiz/engine/scoring.ts`. |
| `generate.ts` | `buildItems`, `runGeneration`, `previewStyle`, `fillDailyEdition`, `listRuns`. |
| `engine.test.ts` | Every builder must produce valid items from a fake catalog; scoring and validator cases. |

## Answer types

A style is a *builder*; what the app draws is decided by its **answer type**.
The app has one renderer per type, so a new style that reuses these needs **no
app release** — only a backend deploy and a seed row.

| Type | Player does | `answer` shape |
|---|---|---|
| `single` | taps one option | `{ correct: [id] }` |
| `binary` | taps one of exactly two | `{ correct: [id] }` |
| `multi` | taps several, then Check (`media.select_count` = exactly N) | `{ correct: [ids] }` |
| `order` | taps options in order | `{ order: [ids] }` |
| `match` | assigns each option to a `media.targets` label | `{ pairs: { optionId: targetId } }` |
| `numeric` | moves a slider (`media.slider`) | `{ value, full_within, zero_beyond, display }` |
| `text` | types, or builds from `media.letters` | `{ accept: [strings], display }` |

Display hints the app understands (no image processing — all CSS):
`options_as` (`text` / `image` / `tiles`), `columns`, `crop`, `flip`, `hole`,
`reveal` + `reveal_seconds` (`zoom` / `blur` / `tiles`), `caption`, `clues`,
`image_after_answer`, `compare`, `suggestions`.

A crop `{ x, y, scale }` scales the image by `scale` around the CSS
transform-origin `(x, y)`. Tile `(col, row)` of an n×n grid is
`tileCrop(col, row, n)` = `{ x: col/(n-1), y: row/(n-1), scale: n }`.

## Adding a style

1. **Write the builder** in the matching `styles/*.ts` file:

   ```ts
   export const myStyle: StyleBuilder = {
     id: "my_style",                 // permanent — it's the quiz_styles key
     label: "My style",
     answerType: "single",
     description: "One line for the admin panel.",
     surfaces: ["practice"],
     settings: [
       { key: "options", label: "Images", type: "number", min: 3, max: 6 },
       DIFFICULTY_FIELD,
     ],
     defaults: { options: 4, difficulty: "mixed" },
     build(ctx, settings) {
       const [target] = candidates(ctx, (a) => Boolean(a.period));
       if (!target) return null;     // null = "couldn't make one this try"
       // …build options + answer from target…
     },
   };
   ```

   - Use `candidates(ctx, test)` for the subject so the same artwork isn't the
     subject twice in one run (`ctx.used`).
   - Use `ctx.rng`, never `Math.random`, so runs are reproducible from a seed.
   - Return `null` freely; `buildItems` tries `count × 8` times.
   - Put every artwork the question shows in `artwork_ids`, subject first.
2. **Register it** in `styles/index.ts` (`STYLE_BUILDERS`).
3. **Seed it** in `museum-app/supabase/quiz-engine.sql` (the `insert into
   public.quiz_styles` list, `enabled = false`) and re-run that file in
   Supabase. Without the row the admin panel shows a "no row" warning.
4. **Test:** `npm test` — `engine.test.ts` automatically checks every
   registered builder produces valid items. Then on EC2:
   `npm run quiz:generate -- --dry-run --style=my_style --count=5`.
5. **Deploy** (`npm run deploy`) and switch it on in the admin panel.

A **new answer type** also needs: the type in `ANSWER_TYPES` (both repos), a
case in `validateItem` and `scoreResponse` (both repos), a renderer in
`museum-app/src/components/quiz/`, the type in the SQL `answer_type` check,
and an app release. Old apps never receive it: they send the answer types
they support with every request.

## Rules the validator enforces

- Known answer type and difficulty; prompt 1–500 chars; `media.label` set.
- Every image URL is `http(s)`; option ids unique; text labels unique.
- `single` / `binary` exactly one correct option; `binary` exactly 2 options;
  `multi` at least one correct but not all.
- `order` lists every option once; `match` pairs every option to an existing
  target; `numeric` slider strictly contains the answer; `text` has a non-empty
  accept list.

A rejected item is counted in the run's `rejected` and its first problems are
logged — never saved.

**Duplicates:** `fingerprint` = SHA-1 of style + sorted artwork ids + prompt +
answer. It's `unique` in `quiz_items`, and inserts use
`on conflict do nothing`, so re-running never duplicates a question.

## Daily edition

`fillDailyEdition(date)` tops the UTC day up to `quiz_engine_config.daily_count`:

- only enabled styles whose `surfaces` include `daily`;
- skips questions used in any daily edition in the last **60 days**;
- round-robins across styles so one style can't fill the day;
- never shows the same artwork twice in one day;
- never removes existing rows (admin or generated).

The old `quiz:daily` job keeps writing the classic `daily_quiz_questions` for
app versions without the engine — the two editions are independent.

## Run lock

A run inserts a `running` row in `quiz_generation_runs` first. Another run
started while one is `running` gets **409** ("already in progress"). A run
that crashed without finishing stops blocking after **30 minutes**.

## CLI

```bash
npm run quiz:generate                       # enabled styles + daily top-up
npm run quiz:generate -- --dry-run          # build + print samples, write nothing
npm run quiz:generate -- --style=timeline,year_slider --count=5
npm run quiz:generate -- --no-daily
npm run quiz:generate -- --date=2026-10-20  # daily edition for that UTC day
```

Use the `:prod` variant on EC2 (runs the compiled `dist/`).

## Admin API

All under `/api/admin/quiz/engine`, admin token required
(`Authorization: Bearer <supabase access token>`, `profiles.role = 'admin'`).

| Request | Response |
|---|---|
| `GET /styles` | `{ styles: [{ id, label, answer_type, description, surfaces, settings, defaults }] }` |
| `POST /preview` `{ style, settings?, count? }` (count 1–10, default 3) | `{ items: QuizItemDraft[], rejected, problems }` — nothing saved |
| `POST /run` `{ style?, count?, fill_daily? }` (count ≤ 200; `fill_daily` default true) | `{ runId, created: {style: n}, rejected, problems, daily: { date, added, total } }` |
| `GET /runs?limit=20` | `{ runs: [{ id, trigger, status, started_at, finished_at, created, rejected, problems, daily_added }] }` |

Style switches, `per_run`, `surfaces`, `settings` and `require_review` are
written by the app straight to `quiz_styles` under admin RLS — there is no
backend route for them.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| A style always builds 0 | The catalog lacks the data it needs (e.g. `more_loved` needs like counts, `placard_match` descriptions, `timeline` parseable years). Check with `--dry-run --style=…`; the run's `problems` lists validator errors. Leave it off or loosen its settings. |
| `quiz_styles: … (run supabase/quiz-engine.sql?)` | The SQL hasn't been applied to this database. |
| 409 on Generate now | Another run is active (cron at 00:10 UTC?). Wait a minute. |
| A run stuck `running` | The process died mid-run. It stops blocking after 30 min; nothing is half-saved except already-inserted items, which are valid. |
| Daily edition empty | No enabled style has the `daily` surface, or every candidate was used in the last 60 days — generate more (`per_run`) or enable more styles. The app falls back to the classic edition. |
| `X: no builder in this backend version` | `quiz_styles` has a row the deployed code doesn't know — deploy the newer backend. |
