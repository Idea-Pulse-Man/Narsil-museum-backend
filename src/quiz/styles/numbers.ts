/** Number styles: year slider, before / after, older / newer, more loved. */
import { randInt } from "../random.js";
import {
  DIFFICULTY_FIELD,
  candidates,
  caption,
  difficultyOf,
  formatYear,
  imageOption,
  num,
  trimLabel,
  type StyleBuilder,
} from "./shared.js";

const roundTo = (v: number, step: number) => Math.round(v / step) * step;

export const yearSlider: StyleBuilder = {
  id: "year_slider",
  label: "Year slider",
  answerType: "numeric",
  description: "“When was this made?” — slide to a year; closer earns more.",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "full_within", label: "Full points within (years)", type: "number", min: 0, max: 100 },
    { key: "zero_beyond", label: "No points beyond (years)", type: "number", min: 20, max: 1000 },
    { key: "window", label: "Slider width (years)", type: "number", min: 100, max: 2000 },
    DIFFICULTY_FIELD,
  ],
  defaults: { full_within: 10, zero_beyond: 150, window: 400, difficulty: "mixed" },

  build(ctx, settings) {
    const full = num(settings, "full_within", 10);
    const zero = Math.max(full + 1, num(settings, "zero_beyond", 150));
    const width = num(settings, "window", 400);
    const [target] = candidates(ctx, (a) => a.yearNum != null);
    if (!target) return null;
    const y = target.yearNum!;
    // Put the answer somewhere random inside the window so the slider's
    // middle never gives it away.
    const at = 0.15 + ctx.rng() * 0.7;
    let min = roundTo(y - width * at, 50);
    let max = roundTo(min + width, 50);
    if (min >= y) min = roundTo(y - 50, 50) - 50;
    if (max <= y) max = roundTo(y + 50, 50) + 50;
    max = Math.min(max, new Date().getUTCFullYear());
    if (!(min < y && y < max)) return null;
    return {
      style: "year_slider",
      answer_type: "numeric",
      prompt: "When was this made?",
      media: {
        label: "Year",
        image_url: target.image,
        artwork_id: target.id,
        accent: target.accent,
        slider: { min, max, step: 1 },
      },
      options: [],
      answer: {
        value: y,
        full_within: full,
        zero_beyond: zero,
        display: target.year || formatYear(y),
      },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id],
    };
  },
};

export const beforeAfter: StyleBuilder = {
  id: "before_after",
  label: "Before or after",
  answerType: "binary",
  description: "“Was this made before or after 1500?”",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "min_gap", label: "Min years from the pivot", type: "number", min: 10, max: 300 },
    DIFFICULTY_FIELD,
  ],
  defaults: { min_gap: 40, difficulty: "mixed" },

  build(ctx, settings) {
    const gap = num(settings, "min_gap", 40);
    const [target] = candidates(ctx, (a) => a.yearNum != null);
    if (!target) return null;
    const y = target.yearNum!;
    const sign = ctx.rng() < 0.5 ? -1 : 1;
    let pivot = roundTo(y + sign * randInt(gap, gap + 150, ctx.rng), 50);
    if (Math.abs(pivot - y) < gap) pivot += sign * 50;
    if (Math.abs(pivot - y) < gap || pivot > new Date().getUTCFullYear()) return null;
    const p = formatYear(pivot);
    return {
      style: "before_after",
      answer_type: "binary",
      prompt: `Was this made before or after ${p}?`,
      media: { label: "Before or after", image_url: target.image, artwork_id: target.id, accent: target.accent },
      options: [
        { id: "before", label: `Before ${p}` },
        { id: "after", label: `After ${p}` },
      ],
      answer: { correct: [y < pivot ? "before" : "after"] },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id],
    };
  },
};

export const olderNewer: StyleBuilder = {
  id: "older_newer",
  label: "Older or newer",
  answerType: "binary",
  description: "“Is this older or newer than the other work?”",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "min_gap", label: "Min years apart", type: "number", min: 5, max: 500 },
    DIFFICULTY_FIELD,
  ],
  defaults: { min_gap: 30, difficulty: "mixed" },

  build(ctx, settings) {
    const gap = num(settings, "min_gap", 30);
    const pool = candidates(ctx, (a) => a.yearNum != null);
    const target = pool[0];
    if (!target) return null;
    const other = pool.find((a) => Math.abs(a.yearNum! - target.yearNum!) >= gap);
    if (!other) return null;
    const older = target.yearNum! < other.yearNum!;
    return {
      style: "older_newer",
      answer_type: "binary",
      prompt: `Is this older or newer than “${trimLabel(other.title || "the other work", 50)}”?`,
      media: {
        label: "Older or newer",
        image_url: target.image,
        artwork_id: target.id,
        accent: target.accent,
        compare: {
          image_url: other.image,
          artwork_id: other.id,
          accent: other.accent,
          label: trimLabel(other.title || "Untitled", 40),
        },
      },
      options: [
        { id: "older", label: "Older" },
        { id: "newer", label: "Newer" },
      ],
      answer: { correct: [older ? "older" : "newer"] },
      explain: `${target.year || formatYear(target.yearNum!)} vs ${other.year || formatYear(other.yearNum!)}`,
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id, other.id],
    };
  },
};

export const moreLoved: StyleBuilder = {
  id: "more_loved",
  label: "More loved",
  answerType: "binary",
  description: "“Which one do Narsil members like more?” (uses like counts).",
  surfaces: ["practice"],
  settings: [
    { key: "min_gap", label: "Min like difference", type: "number", min: 1, max: 500 },
    DIFFICULTY_FIELD,
  ],
  defaults: { min_gap: 3, difficulty: "apprentice" },

  build(ctx, settings) {
    const gap = num(settings, "min_gap", 3);
    const pool = candidates(ctx, () => true);
    const target = pool.find((a) => a.likeCount >= gap);
    if (!target) return null;
    const other = pool.find(
      (a) => a.id !== target.id && Math.abs(a.likeCount - target.likeCount) >= gap,
    );
    if (!other) return null;
    const flip = ctx.rng() < 0.5;
    const [first, second] = flip ? [other, target] : [target, other];
    const winner = target.likeCount > other.likeCount ? target : other;
    const likes = (n: number) => `${n} like${n === 1 ? "" : "s"}`;
    return {
      style: "more_loved",
      answer_type: "binary",
      prompt: "Which one do Narsil members like more?",
      media: { label: "More loved", options_as: "image", columns: 2 },
      options: [
        imageOption(first, "a", { note: likes(first.likeCount) }),
        imageOption(second, "b", { note: likes(second.likeCount) }),
      ],
      answer: { correct: [winner === first ? "a" : "b"] },
      explain: caption(winner),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [first.id, second.id],
    };
  },
};
