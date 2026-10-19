/** Ordering and matching styles: timeline, match pairs, sort into groups. */
import type { QuizArt } from "../catalog.js";
import { shuffle } from "../random.js";
import type { ItemTarget } from "../types.js";
import {
  DIFFICULTY_FIELD,
  candidates,
  difficultyOf,
  fieldChoices,
  fieldValue,
  formatYear,
  groupBy,
  imageOption,
  key,
  num,
  OPTION_IDS,
  str,
  trimLabel,
  type BuildContext,
  type Field,
  type StyleBuilder,
} from "./shared.js";

/** `n` works whose `field` values are all different. */
function distinctBy(ctx: BuildContext, field: Field, n: number): QuizArt[] {
  const out: QuizArt[] = [];
  const seen = new Set<string>();
  for (const art of candidates(ctx, (a) => Boolean(fieldValue(a, field)))) {
    const k = key(fieldValue(art, field));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(art);
    if (out.length === n) break;
  }
  return out;
}

export const timeline: StyleBuilder = {
  id: "timeline",
  label: "Timeline",
  answerType: "order",
  description: "Put the works in order, oldest first.",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "items", label: "Works", type: "number", min: 3, max: 5 },
    { key: "min_gap", label: "Min years apart", type: "number", min: 5, max: 300 },
    DIFFICULTY_FIELD,
  ],
  defaults: { items: 4, min_gap: 30, difficulty: "mixed" },

  build(ctx, settings) {
    const n = num(settings, "items", 4);
    const gap = num(settings, "min_gap", 30);
    const picked: QuizArt[] = [];
    for (const art of candidates(ctx, (a) => a.yearNum != null)) {
      if (picked.every((p) => Math.abs(p.yearNum! - art.yearNum!) >= gap)) {
        picked.push(art);
        if (picked.length === n) break;
      }
    }
    if (picked.length < n) return null;
    const options = picked.map((a, i) =>
      imageOption(a, OPTION_IDS[i]!, { note: a.year || formatYear(a.yearNum!) }),
    );
    const order = [...picked]
      .sort((a, b) => a.yearNum! - b.yearNum!)
      .map((a) => OPTION_IDS[picked.indexOf(a)]!);
    return {
      style: "timeline",
      answer_type: "order",
      prompt: "Put these in order — oldest first.",
      media: { label: "Timeline", options_as: "image", columns: 2 },
      options,
      answer: { order },
      explain: [...picked]
        .sort((a, b) => a.yearNum! - b.yearNum!)
        .map((a) => a.year || formatYear(a.yearNum!))
        .join(" → "),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: picked.map((a) => a.id),
    };
  },
};

function matchStyle(
  id: string,
  label: string,
  description: string,
  fields: Field[],
  defaultField: Field,
  prompt: (field: Field) => string,
): StyleBuilder {
  return {
    id,
    label,
    answerType: "match",
    description,
    surfaces: ["practice"],
    settings: [
      { key: "field", label: "Match to", type: "select", options: fieldChoices(fields) },
      { key: "pairs", label: "Pairs", type: "number", min: 2, max: 4 },
      DIFFICULTY_FIELD,
    ],
    defaults: { field: defaultField, pairs: 3, difficulty: "mixed" },

    build(ctx, settings) {
      const field = str(settings, "field", defaultField) as Field;
      const n = num(settings, "pairs", 3);
      const works = distinctBy(ctx, field, n);
      if (works.length < n) return null;
      const targetOrder = shuffle(works, ctx.rng);
      const targets: ItemTarget[] = targetOrder.map((a, i) => ({
        id: `t${i + 1}`,
        label: trimLabel(fieldValue(a, field), 40),
      }));
      const options = works.map((a, i) => imageOption(a, OPTION_IDS[i]!));
      const pairs: Record<string, string> = {};
      works.forEach((a, i) => {
        pairs[OPTION_IDS[i]!] = targets[targetOrder.indexOf(a)]!.id;
      });
      return {
        style: id,
        answer_type: "match",
        prompt: prompt(field),
        media: { label, targets, options_as: "image" },
        options,
        answer: { pairs },
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: works.map((a) => a.id),
      };
    },
  };
}

export const matchPairs = matchStyle(
  "match_pairs",
  "Match pairs",
  "Match each work to its artist.",
  ["artist", "title"],
  "artist",
  (f) => (f === "title" ? "Match each work to its title." : "Match each work to its artist."),
);

export const matchPeriod = matchStyle(
  "match_period",
  "Match to period",
  "Match each work to its period or civilisation.",
  ["period", "empire"],
  "period",
  (f) => (f === "empire" ? "Match each work to its civilisation." : "Match each work to its period."),
);

export const sortGroups: StyleBuilder = {
  id: "sort_groups",
  label: "Sort into groups",
  answerType: "match",
  description: "“Greek or Roman?” — sort six works into two groups.",
  surfaces: ["practice"],
  settings: [
    { key: "field", label: "Group by", type: "select", options: fieldChoices(["empire", "period", "artist"]) },
    { key: "items", label: "Works", type: "number", min: 4, max: 8 },
    DIFFICULTY_FIELD,
  ],
  defaults: { field: "empire", items: 6, difficulty: "mixed" },

  build(ctx, settings) {
    const field = str(settings, "field", "empire") as Field;
    const n = num(settings, "items", 6);
    const half = Math.floor(n / 2);
    const pool = candidates(ctx, () => true);
    // Prefer two groups from the same category (Greek vs Roman sculpture).
    const byCategory = new Map<string, QuizArt[]>();
    for (const art of pool) {
      const list = byCategory.get(art.category) ?? [];
      list.push(art);
      byCategory.set(art.category, list);
    }
    const tries = [...shuffle([...byCategory.values()], ctx.rng), pool];
    for (const arts of tries) {
      const groups = [...groupBy(arts, field).values()].filter((g) => g.length >= n - half);
      if (groups.length < 2) continue;
      const [ga, gb] = shuffle(groups, ctx.rng);
      const a = ga!.slice(0, half);
      const b = gb!.slice(0, n - half);
      const targets: ItemTarget[] = [
        { id: "t1", label: trimLabel(fieldValue(a[0]!, field), 30) },
        { id: "t2", label: trimLabel(fieldValue(b[0]!, field), 30) },
      ];
      const works = shuffle([...a, ...b], ctx.rng);
      const pairs: Record<string, string> = {};
      const options = works.map((w, i) => {
        pairs[OPTION_IDS[i]!] = a.includes(w) ? "t1" : "t2";
        return imageOption(w, OPTION_IDS[i]!, { note: fieldValue(w, field) });
      });
      return {
        style: "sort_groups",
        answer_type: "match",
        prompt: `Sort these: ${targets[0]!.label} or ${targets[1]!.label}?`,
        media: { label: "Sort", targets, options_as: "image", columns: 3 },
        options,
        answer: { pairs },
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: works.map((w) => w.id),
      };
    }
    return null;
  },
};
