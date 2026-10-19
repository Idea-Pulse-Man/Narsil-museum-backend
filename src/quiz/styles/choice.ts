/**
 * Image-answer styles: the question is text, the answers are artworks.
 * Distractors come from the same category first, so a Roman marble sits next
 * to Greek and Etruscan marbles rather than next to a Dutch landscape.
 */
import type { QuizArt } from "../catalog.js";
import { randInt, shuffle } from "../random.js";
import type { ItemOption } from "../types.js";
import {
  DIFFICULTY_FIELD,
  candidates,
  caption,
  difficultyOf,
  distractorsFor,
  fieldChoices,
  fieldValue,
  groupBy,
  imageOption,
  isPhrase,
  key,
  noteFor,
  num,
  OPTION_IDS,
  similarWorks,
  str,
  type Field,
  type StyleBuilder,
} from "./shared.js";

const GROUP_FIELDS: Field[] = ["empire", "period", "artist", "medium"];

/** Shuffle works into lettered image options; returns options + id per work. */
function toOptions(works: QuizArt[], field: Field | undefined, rng: () => number) {
  const order = shuffle(works, rng);
  const idOf = new Map<string, string>();
  const options: ItemOption[] = order.map((art, i) => {
    const id = OPTION_IDS[i]!;
    idOf.set(art.id, id);
    return imageOption(art, id, { note: noteFor(art, field) });
  });
  return { options, idOf };
}

export const pickImage: StyleBuilder = {
  id: "pick_image",
  label: "Pick one",
  answerType: "single",
  description: "“Which one is Roman?” — four similar artworks, tap the right one.",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "field", label: "Ask about", type: "select", options: fieldChoices(GROUP_FIELDS) },
    { key: "options", label: "Images", type: "number", min: 3, max: 6 },
    DIFFICULTY_FIELD,
  ],
  defaults: { field: "empire", options: 4, difficulty: "mixed" },

  build(ctx, settings) {
    const field = str(settings, "field", "empire") as Field;
    const n = num(settings, "options", 4);
    for (const target of candidates(ctx, (a) => Boolean(fieldValue(a, field))).slice(0, 30)) {
      const value = fieldValue(target, field);
      const others = distractorsFor(ctx, target, field, new Set([key(value)]), n - 1);
      if (others.length < n - 1) continue;
      const { options, idOf } = toOptions([target, ...others], field, ctx.rng);
      return {
        style: "pick_image",
        answer_type: "single",
        prompt: `Which one is ${isPhrase(field, value)}?`,
        media: { label: "Pick one", options_as: "image", columns: n > 4 ? 3 : 2 },
        options,
        answer: { correct: [idOf.get(target.id)!] },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id, ...others.map((o) => o.id)],
      };
    }
    return null;
  },
};

export const selectAll: StyleBuilder = {
  id: "select_all",
  label: "Select all",
  answerType: "multi",
  description: "“Tap every Impressionist work” — several right answers.",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "field", label: "Ask about", type: "select", options: fieldChoices(["period", "artist", "empire"]) },
    { key: "options", label: "Images", type: "number", min: 4, max: 8 },
    { key: "min_correct", label: "Min right answers", type: "number", min: 1, max: 4 },
    { key: "max_correct", label: "Max right answers", type: "number", min: 1, max: 5 },
    DIFFICULTY_FIELD,
  ],
  defaults: { field: "period", options: 6, min_correct: 2, max_correct: 3, difficulty: "mixed" },

  build(ctx, settings) {
    const field = str(settings, "field", "period") as Field;
    const n = num(settings, "options", 6);
    const lo = num(settings, "min_correct", 2);
    const hi = Math.max(lo, num(settings, "max_correct", 3));
    const groups = [...groupBy(candidates(ctx, () => true), field).values()].filter(
      (g) => g.length >= lo,
    );
    for (const group of shuffle(groups, ctx.rng).slice(0, 20)) {
      const k = Math.min(randInt(lo, hi, ctx.rng), group.length, n - 1);
      const right = shuffle(group, ctx.rng).slice(0, k);
      const value = fieldValue(right[0]!, field);
      const wrong = distractorsFor(ctx, right[0]!, field, new Set([key(value)]), n - k);
      if (wrong.length < n - k) continue;
      const { options, idOf } = toOptions([...right, ...wrong], field, ctx.rng);
      return {
        style: "select_all",
        answer_type: "multi",
        prompt: `Tap every work that is ${isPhrase(field, value)}.`,
        media: { label: "Select all", options_as: "image", columns: n > 4 ? 3 : 2 },
        options,
        answer: { correct: right.map((a) => idOf.get(a.id)!) },
        explain: `${right.length} of ${n} are ${isPhrase(field, value)}.`,
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [...right, ...wrong].map((a) => a.id),
      };
    }
    return null;
  },
};

export const oddOneOut: StyleBuilder = {
  id: "odd_one_out",
  label: "Odd one out",
  answerType: "single",
  description: "“Which one is NOT by Monet?” — three belong together, one doesn't.",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "field", label: "Group by", type: "select", options: fieldChoices(["artist", "period", "empire"]) },
    { key: "options", label: "Images", type: "number", min: 3, max: 6 },
    DIFFICULTY_FIELD,
  ],
  defaults: { field: "artist", options: 4, difficulty: "mixed" },

  build(ctx, settings) {
    const field = str(settings, "field", "artist") as Field;
    const n = num(settings, "options", 4);
    const groups = [...groupBy(candidates(ctx, () => true), field).values()].filter(
      (g) => g.length >= n - 1,
    );
    for (const group of shuffle(groups, ctx.rng).slice(0, 20)) {
      const members = shuffle(group, ctx.rng).slice(0, n - 1);
      const value = fieldValue(members[0]!, field);
      const [intruder] = distractorsFor(ctx, members[0]!, field, new Set([key(value)]), 1);
      if (!intruder) continue;
      const { options, idOf } = toOptions([...members, intruder], field, ctx.rng);
      return {
        style: "odd_one_out",
        answer_type: "single",
        prompt: `Which one is NOT ${isPhrase(field, value)}?`,
        media: { label: "Odd one out", options_as: "image", columns: n > 4 ? 3 : 2 },
        options,
        answer: { correct: [idOf.get(intruder.id)!] },
        explain: caption(intruder),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [...members, intruder].map((a) => a.id),
      };
    }
    return null;
  },
};

const PAIR_PROMPT: Partial<Record<Field, string>> = {
  artist: "Which two are by the same artist?",
  period: "Which two are from the same period?",
  empire: "Which two come from the same civilisation?",
};

export const findPair: StyleBuilder = {
  id: "find_pair",
  label: "Find the pair",
  answerType: "multi",
  description: "“Which two are by the same artist?” — tap exactly two.",
  surfaces: ["practice"],
  settings: [
    { key: "field", label: "Pair by", type: "select", options: fieldChoices(["artist", "period", "empire"]) },
    { key: "options", label: "Images", type: "number", min: 4, max: 6 },
    DIFFICULTY_FIELD,
  ],
  defaults: { field: "artist", options: 4, difficulty: "mixed" },

  build(ctx, settings) {
    const field = str(settings, "field", "artist") as Field;
    const n = num(settings, "options", 4);
    const groups = [...groupBy(candidates(ctx, () => true), field).values()].filter(
      (g) => g.length >= 2,
    );
    for (const group of shuffle(groups, ctx.rng).slice(0, 20)) {
      const pair = shuffle(group, ctx.rng).slice(0, 2);
      const value = fieldValue(pair[0]!, field);
      // The rest must all differ from the pair AND from each other.
      const rest = distractorsFor(ctx, pair[0]!, field, new Set([key(value)]), n - 2);
      const restValues = new Set(rest.map((a) => key(fieldValue(a, field))));
      if (rest.length < n - 2 || restValues.size !== rest.length) continue;
      const { options, idOf } = toOptions([...pair, ...rest], field, ctx.rng);
      return {
        style: "find_pair",
        answer_type: "multi",
        prompt: PAIR_PROMPT[field] ?? "Which two belong together?",
        media: { label: "Find the pair", options_as: "image", columns: 2, select_count: 2 },
        options,
        answer: { correct: pair.map((a) => idOf.get(a.id)!) },
        explain: `Both are ${isPhrase(field, value)}.`,
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [...pair, ...rest].map((a) => a.id),
      };
    }
    return null;
  },
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Placard text with the title and artist names blanked out, ~260 chars. */
export function maskPlacard(art: QuizArt, maxChars = 260): string {
  let text = art.description.replace(/\s+/g, " ").trim();
  const names = [
    art.title,
    art.artistName,
    ...art.artistName.split(/\s+/).filter((w) => w.length >= 4),
  ].filter((n) => n.length >= 4);
  for (const name of names.sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRe(name), "gi"), "▁▁▁");
  }
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const end = cut.lastIndexOf(". ");
  return end > maxChars * 0.5 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

export const placardMatch: StyleBuilder = {
  id: "placard_match",
  label: "Placard match",
  answerType: "single",
  description: "Read the museum label (names hidden), pick the artwork it describes.",
  surfaces: ["practice"],
  settings: [
    { key: "options", label: "Images", type: "number", min: 3, max: 6 },
    { key: "min_chars", label: "Min label length", type: "number", min: 40, max: 400 },
    DIFFICULTY_FIELD,
  ],
  defaults: { options: 4, min_chars: 90, difficulty: "mixed" },

  build(ctx, settings) {
    const n = num(settings, "options", 4);
    const minChars = num(settings, "min_chars", 90);
    for (const target of candidates(ctx, (a) => a.description.length >= minChars).slice(0, 20)) {
      const text = maskPlacard(target);
      if (text.length < minChars * 0.6) continue;
      const others = similarWorks(ctx, target, n - 1);
      if (others.length < n - 1) continue;
      const { options, idOf } = toOptions([target, ...others], undefined, ctx.rng);
      return {
        style: "placard_match",
        answer_type: "single",
        prompt: "Which work does this museum label describe?",
        media: { label: "Placard", caption: text, options_as: "image", columns: n > 4 ? 3 : 2 },
        options,
        answer: { correct: [idOf.get(target.id)!] },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id, ...others.map((o) => o.id)],
      };
    }
    return null;
  },
};
