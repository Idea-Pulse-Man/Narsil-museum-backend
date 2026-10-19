/** Word and fact styles. */
import type { QuizArt } from "../catalog.js";
import { shuffle } from "../random.js";
import {
  DIFFICULTY_FIELD,
  candidates,
  caption,
  centuryLabel,
  difficultyOf,
  fieldChoices,
  fieldValue,
  isPhrase,
  key,
  num,
  OPTION_IDS,
  str,
  trimLabel,
  type Field,
  type StyleBuilder,
} from "./shared.js";

const mainImage = (art: QuizArt, label: string) => ({
  label,
  image_url: art.image,
  artwork_id: art.id,
  accent: art.accent,
});

/** A value of `field` from another work that differs from `art`'s. */
function otherValue(all: QuizArt[], art: QuizArt, field: Field, rng: () => number): string {
  const own = key(fieldValue(art, field));
  for (const a of shuffle(all, rng).slice(0, 400)) {
    const v = fieldValue(a, field);
    if (v && key(v) !== own) return v;
  }
  return "";
}

export const trueFalse: StyleBuilder = {
  id: "true_false",
  label: "True or false",
  answerType: "binary",
  description: "“True or false: this is by Monet.” Fast yes / no.",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "field", label: "Statement about", type: "select", options: fieldChoices(["artist", "period", "empire", "medium", "museum"]) },
    DIFFICULTY_FIELD,
  ],
  defaults: { field: "artist", difficulty: "apprentice" },

  build(ctx, settings) {
    const field = str(settings, "field", "artist") as Field;
    const [target] = candidates(ctx, (a) => Boolean(fieldValue(a, field)));
    if (!target) return null;
    const truth = ctx.rng() < 0.5;
    const value = truth
      ? fieldValue(target, field)
      : otherValue(ctx.catalog.arts, target, field, ctx.rng);
    if (!value) return null;
    return {
      style: "true_false",
      answer_type: "binary",
      prompt: `True or false: this work is ${isPhrase(field, value)}.`,
      media: mainImage(target, "True or false"),
      options: [
        { id: "true", label: "True" },
        { id: "false", label: "False" },
      ],
      answer: { correct: [truth ? "true" : "false"] },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id],
    };
  },
};

type Fact = { field: Field | "year"; text: (v: string) => string };

const FACTS: Fact[] = [
  { field: "year", text: (v) => `It was made in ${v}.` },
  { field: "medium", text: (v) => `Its medium is ${v.toLowerCase()}.` },
  { field: "museum", text: (v) => `It is held at ${v}.` },
  { field: "artist", text: (v) => `It is by ${v}.` },
  { field: "period", text: (v) => `It is ${isPhrase("period", v)}.` },
  { field: "empire", text: (v) => `It comes from the ${v} world.` },
];

const factValue = (a: QuizArt, f: Fact["field"]) =>
  f === "year" ? (/\d/.test(a.year) ? a.year : "") : fieldValue(a, f);

export const twoTruths: StyleBuilder = {
  id: "two_truths",
  label: "Two truths and a lie",
  answerType: "single",
  description: "Three facts about the work — one is false.",
  surfaces: ["practice"],
  settings: [DIFFICULTY_FIELD],
  defaults: { difficulty: "scholar" },

  build(ctx, settings) {
    for (const target of candidates(ctx, () => true).slice(0, 40)) {
      const facts = shuffle(FACTS.filter((f) => factValue(target, f.field)), ctx.rng).slice(0, 3);
      if (facts.length < 3) continue;
      const lieAt = Math.floor(ctx.rng() * 3);
      const lieFact = facts[lieAt]!;
      const own = key(factValue(target, lieFact.field));
      const fake = shuffle(ctx.catalog.arts, ctx.rng)
        .slice(0, 400)
        .map((a) => factValue(a, lieFact.field))
        .find((v) => v && key(v) !== own);
      if (!fake) continue;
      const options = facts.map((f, i) => ({
        id: OPTION_IDS[i]!,
        label: trimLabel(f.text(i === lieAt ? fake : factValue(target, f.field)), 90),
      }));
      return {
        style: "two_truths",
        answer_type: "single",
        prompt: "Two of these are true. Which one is the lie?",
        media: mainImage(target, "Two truths, one lie"),
        options,
        answer: { correct: [OPTION_IDS[lieAt]!] },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id],
      };
    }
    return null;
  },
};

const STOP = new Set(["with", "from", "after", "before", "under", "over", "into", "their", "there", "this", "that", "these", "those", "about", "between", "portrait", "untitled"]);
const blankable = (w: string) => /^[A-Za-z][a-z]{3,}$/.test(w) && !STOP.has(w.toLowerCase());

export const fillTitle: StyleBuilder = {
  id: "fill_title",
  label: "Fill the title",
  answerType: "single",
  description: "“The Starry ____” — pick the missing word.",
  surfaces: ["daily", "practice"],
  settings: [DIFFICULTY_FIELD],
  defaults: { difficulty: "mixed" },

  build(ctx, settings) {
    const words = [
      ...new Set(
        ctx.catalog.arts.flatMap((a) => a.title.split(/\s+/)).filter(blankable),
      ),
    ];
    for (const target of candidates(ctx, (a) => a.title.split(/\s+/).length >= 2).slice(0, 40)) {
      const parts = target.title.split(/\s+/);
      const at = shuffle(parts.map((_, i) => i).filter((i) => blankable(parts[i]!)), ctx.rng)[0];
      if (at === undefined) continue;
      const answer = parts[at]!;
      const inTitle = new Set(parts.map((p) => p.toLowerCase()));
      const near = shuffle(
        words.filter(
          (w) => !inTitle.has(w.toLowerCase()) && Math.abs(w.length - answer.length) <= 3,
        ),
        ctx.rng,
      ).slice(0, 3);
      if (near.length < 3) continue;
      const blanked = parts.map((p, i) => (i === at ? "_____" : p)).join(" ");
      const values = shuffle([answer, ...near], ctx.rng);
      return {
        style: "fill_title",
        answer_type: "single",
        prompt: `Complete the title: “${trimLabel(blanked, 120)}”`,
        media: mainImage(target, "Fill the title"),
        options: values.map((v, i) => ({ id: OPTION_IDS[i]!, label: v })),
        answer: { correct: [OPTION_IDS[values.indexOf(answer)]!] },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id],
      };
    }
    return null;
  },
};

/** Last name, unless a particle ("van", "da") makes the first name the known one. */
function shortName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  const particle = parts.slice(1, -1).some((p) => /^(van|von|da|de|del|della|di|du|le|la|ten|ter)$/i.test(p));
  return particle ? parts[0]! : parts[parts.length - 1]!;
}

export const typeArtist: StyleBuilder = {
  id: "type_artist",
  label: "Type the artist",
  answerType: "text",
  description: "Type the artist's name with autocomplete (Artle style).",
  surfaces: ["practice"],
  settings: [
    { key: "suggestions", label: "Autocomplete names", type: "number", min: 10, max: 120 },
    DIFFICULTY_FIELD,
  ],
  defaults: { suggestions: 40, difficulty: "master" },

  build(ctx, settings) {
    const size = num(settings, "suggestions", 40);
    const [target] = candidates(ctx, (a) => Boolean(a.artistName));
    if (!target) return null;
    const name = target.artistName;
    const short = shortName(name);
    const shortTaken = ctx.catalog.artistNames.filter((n) => shortName(n).toLowerCase() === short.toLowerCase()).length > 1;
    const others = shuffle(ctx.catalog.artistNames.filter((n) => n !== name), ctx.rng).slice(0, size - 1);
    return {
      style: "type_artist",
      answer_type: "text",
      prompt: "Who made this? Type the artist's name.",
      media: { ...mainImage(target, "Type the artist"), suggestions: [name, ...others].sort() },
      options: [],
      answer: {
        accept: shortTaken || short.length < 4 ? [name] : [name, short],
        display: name,
      },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id],
    };
  },
};

export const unscramble: StyleBuilder = {
  id: "unscramble",
  label: "Unscramble",
  answerType: "text",
  description: "“T E N O M” → Monet. Rebuild the artist's name from letter tiles.",
  surfaces: ["practice"],
  settings: [
    { key: "max_letters", label: "Max letters", type: "number", min: 4, max: 12 },
    DIFFICULTY_FIELD,
  ],
  defaults: { max_letters: 9, difficulty: "mixed" },

  build(ctx, settings) {
    const max = num(settings, "max_letters", 9);
    for (const target of candidates(ctx, (a) => Boolean(a.artistName)).slice(0, 60)) {
      const word = shortName(target.artistName);
      if (!/^[A-Za-z]+$/.test(word) || word.length < 4 || word.length > max) continue;
      const upper = word.toUpperCase();
      let letters = shuffle(upper.split(""), ctx.rng);
      for (let i = 0; i < 5 && letters.join("") === upper; i++) letters = shuffle(letters, ctx.rng);
      if (letters.join("") === upper) continue;
      return {
        style: "unscramble",
        answer_type: "text",
        prompt: `Unscramble the artist's name (${word.length} letters).`,
        media: { ...mainImage(target, "Unscramble"), letters },
        options: [],
        answer: { accept: [word, target.artistName], display: target.artistName },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id],
      };
    }
    return null;
  },
};

export const clueLadder: StyleBuilder = {
  id: "clue_ladder",
  label: "Clue ladder",
  answerType: "single",
  description: "Clues appear one at a time — name the artist as early as you can.",
  surfaces: ["practice"],
  settings: [
    { key: "seconds", label: "Seconds between clues", type: "number", min: 1, max: 10 },
    DIFFICULTY_FIELD,
  ],
  defaults: { seconds: 3, difficulty: "scholar" },

  build(ctx, settings) {
    const seconds = num(settings, "seconds", 3);
    for (const target of candidates(ctx, (a) => Boolean(a.artistName)).slice(0, 40)) {
      // Vaguest first; the period last because it gives most away.
      const clues = [
        target.empire || target.nationality ? `From: ${target.empire || target.nationality}` : "",
        target.yearNum != null ? `Made in ${centuryLabel(target.yearNum)}` : "",
        target.medium ? `Medium: ${target.medium}` : "",
        target.subject ? `Subject: ${target.subject}` : "",
        target.period ? `Period: ${target.period}` : "",
      ].filter(Boolean);
      if (clues.length < 3) continue;
      const seen = new Set([key(target.artistName)]);
      const names = shuffle(ctx.catalog.artistNames, ctx.rng).filter((n) => {
        if (seen.has(key(n))) return false;
        seen.add(key(n));
        return true;
      });
      const others = names.slice(0, 3);
      if (others.length < 3) continue;
      const values = shuffle([target.artistName, ...others], ctx.rng);
      return {
        style: "clue_ladder",
        answer_type: "single",
        prompt: "Name the artist from the clues.",
        media: {
          ...mainImage(target, "Clue ladder"),
          clues,
          reveal_seconds: seconds,
          image_after_answer: true,
        },
        options: values.map((v, i) => ({ id: OPTION_IDS[i]!, label: v })),
        answer: { correct: [OPTION_IDS[values.indexOf(target.artistName)]!] },
        explain: caption(target),
        difficulty: difficultyOf(settings, ctx.rng),
        artwork_ids: [target.id],
      };
    }
    return null;
  },
};

