/**
 * Image-trick styles. None of these process images: they ship crop / flip /
 * reveal instructions and the app does the effect with CSS.
 */
import type { QuizArt } from "../catalog.js";
import { pick, randInt, shuffle } from "../random.js";
import type { ItemOption, RevealEffect } from "../types.js";
import {
  DIFFICULTY_FIELD,
  candidates,
  caption,
  difficultyOf,
  fieldChoices,
  fieldValue,
  imageOption,
  key,
  num,
  OPTION_IDS,
  similarWorks,
  str,
  tileCrop,
  trimLabel,
  type Field,
  type StyleBuilder,
} from "./shared.js";

export const detailMatch: StyleBuilder = {
  id: "detail_match",
  label: "Detail match",
  answerType: "single",
  description: "A zoomed-in detail — which of four works is it from?",
  surfaces: ["daily", "practice"],
  settings: [
    { key: "zoom", label: "Zoom (×)", type: "number", min: 2, max: 5, step: 0.5 },
    { key: "options", label: "Images", type: "number", min: 3, max: 6 },
    DIFFICULTY_FIELD,
  ],
  defaults: { zoom: 3, options: 4, difficulty: "mixed" },

  build(ctx, settings) {
    const zoom = num(settings, "zoom", 3);
    const n = num(settings, "options", 4);
    const [target] = candidates(ctx, () => true);
    if (!target) return null;
    const others = similarWorks(ctx, target, n - 1);
    if (others.length < n - 1) return null;
    const crop = {
      x: Number((0.2 + ctx.rng() * 0.6).toFixed(2)),
      y: Number((0.2 + ctx.rng() * 0.6).toFixed(2)),
      scale: zoom,
    };
    const order = shuffle([target, ...others], ctx.rng);
    const options = order.map((a, i) => imageOption(a, OPTION_IDS[i]!, { note: trimLabel(a.title, 40) }));
    return {
      style: "detail_match",
      answer_type: "single",
      prompt: "This detail comes from which work?",
      media: {
        label: "Detail",
        image_url: target.image,
        artwork_id: target.id,
        accent: target.accent,
        crop,
        options_as: "image",
        columns: n > 4 ? 3 : 2,
      },
      options,
      answer: { correct: [OPTION_IDS[order.indexOf(target)]!] },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: order.map((a) => a.id),
    };
  },
};

const ASK_PROMPT: Partial<Record<Field, string>> = {
  artist: "Who made this work?",
  title: "What is this work called?",
  period: "Which period is this from?",
  empire: "Which civilisation made this?",
};

function revealStyle(effect: Exclude<RevealEffect, "none">, label: string, description: string): StyleBuilder {
  const id = `${effect}_reveal`;
  return {
    id,
    label,
    answerType: "single",
    description,
    surfaces: ["practice"],
    settings: [
      { key: "ask", label: "Ask about", type: "select", options: fieldChoices(["artist", "title", "period", "empire"]) },
      { key: "seconds", label: "Reveal time (s)", type: "number", min: 4, max: 30 },
      DIFFICULTY_FIELD,
    ],
    defaults: { ask: "artist", seconds: 10, difficulty: "mixed" },

    build(ctx, settings) {
      const ask = str(settings, "ask", "artist") as Field;
      const seconds = num(settings, "seconds", 10);
      for (const target of candidates(ctx, (a) => Boolean(fieldValue(a, ask))).slice(0, 30)) {
        const correct = fieldValue(target, ask);
        const seen = new Set([key(correct)]);
        const pool: string[] = [];
        for (const a of shuffle(ctx.catalog.arts, ctx.rng)) {
          const v = fieldValue(a, ask);
          if (!v || seen.has(key(v))) continue;
          seen.add(key(v));
          pool.push(v);
          if (pool.length === 3) break;
        }
        if (pool.length < 3) continue;
        const values = shuffle([correct, ...pool], ctx.rng);
        return {
          style: id,
          answer_type: "single",
          prompt: ASK_PROMPT[ask] ?? "What is this?",
          media: {
            label,
            image_url: target.image,
            artwork_id: target.id,
            accent: target.accent,
            reveal: effect,
            reveal_seconds: seconds,
          },
          options: values.map((v, i) => ({ id: OPTION_IDS[i]!, label: trimLabel(v) })),
          answer: { correct: [OPTION_IDS[values.indexOf(correct)]!] },
          explain: caption(target),
          difficulty: difficultyOf(settings, ctx.rng),
          artwork_ids: [target.id],
        };
      }
      return null;
    },
  };
}

export const zoomReveal = revealStyle("zoom", "Zoom-out", "Starts on a tiny detail and zooms out — answer early for more points.");
export const blurReveal = revealStyle("blur", "Blur reveal", "Starts blurred and slowly sharpens.");
export const tileReveal = revealStyle("tiles", "Tile reveal", "Nine tiles flip open one by one.");

export const mirror: StyleBuilder = {
  id: "mirror",
  label: "Real or mirrored",
  answerType: "binary",
  description: "The original next to a flipped copy — which is real?",
  surfaces: ["practice"],
  settings: [
    { key: "paintings_only", label: "Paintings only", type: "boolean" },
    DIFFICULTY_FIELD,
  ],
  defaults: { paintings_only: true, difficulty: "master" },

  build(ctx, settings) {
    const paintingsOnly = settings.paintings_only !== false;
    // Scenes with a clear left/right (landscapes, interiors, crowds) work best;
    // near-symmetric portraits and objects are skipped by the subject filter.
    const [target] = candidates(
      ctx,
      (a) =>
        (!paintingsOnly || a.category === "paintings") &&
        !/portrait/i.test(a.subject) &&
        a.category !== "sculptures" &&
        a.category !== "pottery",
    );
    if (!target) return null;
    const flippedFirst = ctx.rng() < 0.5;
    const real = imageOption(target, flippedFirst ? "b" : "a", { note: "Original" });
    const fake = imageOption(target, flippedFirst ? "a" : "b", { flip: true, note: "Mirrored" });
    const options = flippedFirst ? [fake, real] : [real, fake];
    return {
      style: "mirror",
      answer_type: "binary",
      prompt: "One of these is mirrored. Which is the real one?",
      media: { label: "Real or mirrored", options_as: "image", columns: 2 },
      options,
      answer: { correct: [real.id] },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id],
    };
  },
};

export const intruderTile: StyleBuilder = {
  id: "intruder_tile",
  label: "Intruder tile",
  answerType: "single",
  description: "A work cut into 9 tiles — one tile is from a different work.",
  surfaces: ["practice"],
  settings: [DIFFICULTY_FIELD],
  defaults: { difficulty: "mixed" },

  build(ctx, settings) {
    const n = 3;
    const [target] = candidates(ctx, () => true);
    if (!target) return null;
    const [other] = similarWorks(ctx, target, 1);
    if (!other) return null;
    const slot = randInt(0, n * n - 1, ctx.rng);
    const source = randInt(0, n * n - 1, ctx.rng);
    const options: ItemOption[] = [];
    for (let i = 0; i < n * n; i++) {
      const art: QuizArt = i === slot ? other : target;
      const tile = i === slot ? source : i;
      options.push(
        imageOption(art, OPTION_IDS[i]!, { crop: tileCrop(tile % n, Math.floor(tile / n), n) }),
      );
    }
    return {
      style: "intruder_tile",
      answer_type: "single",
      prompt: "One tile comes from a different work. Find it.",
      media: { label: "Intruder tile", options_as: "tiles", columns: n },
      options,
      answer: { correct: [OPTION_IDS[slot]!] },
      explain: `The tile is from ${caption(other)}`,
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id, other.id],
    };
  },
};

export const missingPiece: StyleBuilder = {
  id: "missing_piece",
  label: "Missing piece",
  answerType: "single",
  description: "A square is cut out of the work — which piece fills the gap?",
  surfaces: ["practice"],
  settings: [DIFFICULTY_FIELD],
  defaults: { difficulty: "mixed" },

  build(ctx, settings) {
    const n = 3;
    const [target] = candidates(ctx, () => true);
    if (!target) return null;
    const [other] = similarWorks(ctx, target, 1);
    if (!other) return null;
    const tiles = shuffle(Array.from({ length: n * n }, (_, i) => i), ctx.rng);
    const hole = tiles[0]!;
    const crop = (t: number) => tileCrop(t % n, Math.floor(t / n), n);
    // Two wrong pieces from elsewhere in the same work, one from another work.
    const pieces = shuffle(
      [
        { art: target, tile: hole, right: true },
        { art: target, tile: tiles[1]!, right: false },
        { art: target, tile: tiles[2]!, right: false },
        { art: other, tile: pick(tiles, ctx.rng)!, right: false },
      ],
      ctx.rng,
    );
    const options = pieces.map((p, i) => imageOption(p.art, OPTION_IDS[i]!, { crop: crop(p.tile) }));
    return {
      style: "missing_piece",
      answer_type: "single",
      prompt: "Which piece fills the gap?",
      media: {
        label: "Missing piece",
        image_url: target.image,
        artwork_id: target.id,
        accent: target.accent,
        hole: crop(hole),
        options_as: "image",
        columns: 4,
      },
      options,
      answer: { correct: [OPTION_IDS[pieces.findIndex((p) => p.right)]!] },
      explain: caption(target),
      difficulty: difficultyOf(settings, ctx.rng),
      artwork_ids: [target.id, other.id],
    };
  },
};
