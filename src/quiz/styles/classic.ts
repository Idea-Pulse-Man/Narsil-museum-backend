/**
 * Classic — the original eight modes (one image, four text answers). Same
 * rules as the daily cron (`ingest/dailyQuiz.ts`) and the app generator.
 */
import type { QuizArt } from "../catalog.js";
import { parseYear } from "../catalog.js";
import { pick, shuffle } from "../random.js";
import {
  DIFFICULTY_FIELD,
  difficultyOf,
  candidates,
  caption,
  key,
  list,
  OPTION_IDS,
  trimLabel,
  type StyleBuilder,
} from "./shared.js";

const MODES = {
  what: { label: "Title", prompts: ["What is this work titled?", "Which title belongs to this work?"] },
  who: { label: "Artist", prompts: ["Who created this work?", "Which artist made this?"] },
  age: { label: "Date", prompts: ["When was this work made?", "Which date fits this work?"] },
  where: { label: "Origin", prompts: ["Where is this work from?", "Which place does this work come from?"] },
  medium: { label: "Medium", prompts: ["What medium is this?", "How was this work made?"] },
  period: { label: "Period", prompts: ["Which period does this belong to?", "What period is this work from?"] },
  museum: { label: "Collection", prompts: ["Where is this work held?", "Which collection holds this work?"] },
  subject: { label: "Subject", prompts: ["What kind of scene is this?", "Which subject fits this work?"] },
} as const;

type Mode = keyof typeof MODES;
const MODE_IDS = Object.keys(MODES) as Mode[];

function answerFor(art: QuizArt, mode: Mode): string {
  switch (mode) {
    case "what":
      return art.title;
    case "who":
      return art.artistName;
    case "age":
      return /\d/.test(art.year) ? art.year : "";
    case "where":
      return art.empire || art.nationality;
    case "medium":
      return art.medium;
    case "period":
      return art.period;
    case "museum":
      return art.museum;
    case "subject":
      return art.subject;
  }
}

export const classic: StyleBuilder = {
  id: "classic",
  label: "Classic",
  answerType: "single",
  description: "One artwork, four text answers — the original 8 modes.",
  surfaces: ["daily", "practice"],
  settings: [
    {
      key: "modes",
      label: "Modes",
      type: "multiselect",
      options: MODE_IDS.map((m) => ({ value: m, label: MODES[m].label })),
    },
    DIFFICULTY_FIELD,
  ],
  defaults: { modes: [...MODE_IDS], difficulty: "mixed" },

  build(ctx, settings) {
    const modes = list(settings, "modes", MODE_IDS).filter((m): m is Mode =>
      MODE_IDS.includes(m as Mode),
    );
    const mode = pick(modes, ctx.rng);
    if (!mode) return null;

    for (const target of candidates(ctx, (a) => Boolean(answerFor(a, mode))).slice(0, 40)) {
      const correct = answerFor(target, mode);
      const seen = new Set([key(correct)]);
      let pool = ctx.catalog.arts
        .filter((a) => a.id !== target.id)
        .map((a) => answerFor(a, mode))
        .filter((v) => {
          if (!v || seen.has(key(v))) return false;
          seen.add(key(v));
          return true;
        });
      if (mode === "age") {
        // Nearby dates make the date question a real choice.
        const cy = parseYear(correct);
        pool =
          cy == null
            ? shuffle(pool, ctx.rng)
            : pool
                .map((v) => ({ v, d: Math.abs((parseYear(v) ?? 1e9) - cy) }))
                .sort((a, b) => a.d - b.d)
                .slice(0, 8)
                .map((x) => x.v);
      }
      const distractors = shuffle(pool, ctx.rng).slice(0, 3);
      if (distractors.length < 3) continue;

      const values = shuffle([correct, ...distractors], ctx.rng);
      const options = values.map((v, i) => ({ id: OPTION_IDS[i]!, label: trimLabel(v) }));
      const correctId = options[values.indexOf(correct)]!.id;
      return {
        style: "classic",
        answer_type: "single",
        prompt: pick(MODES[mode].prompts, ctx.rng)!,
        media: {
          label: MODES[mode].label,
          image_url: target.image,
          artwork_id: target.id,
          accent: target.accent,
        },
        options,
        answer: { correct: [correctId] },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id],
      };
    }
    return null;
  },
};
