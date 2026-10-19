/**
 * Quiz question engine — the generic question format.
 * ---------------------------------------------------------------------------
 * Every question style (classic, pick-the-image, year slider…) produces the
 * same `QuizItemDraft` shape, so one table (`quiz_items`) stores them all and
 * the app needs one renderer per *answer type*, not per style.
 *
 * Mirrored in museum-app/src/lib/quiz/engine/types.ts — keep the two in sync.
 */

export const ANSWER_TYPES = [
  "single",
  "multi",
  "binary",
  "order",
  "match",
  "numeric",
  "text",
] as const;

export type AnswerType = (typeof ANSWER_TYPES)[number];

export const DIFFICULTIES = ["apprentice", "scholar", "master"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Where a style's questions may be served. */
export const SURFACES = ["daily", "practice"] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * A zoom window: the image is scaled by `scale` around the CSS
 * transform-origin (`x`, `y`), both 0–1. For an n×n tile grid, tile (col, row)
 * is `{ x: col / (n - 1), y: row / (n - 1), scale: n }`.
 */
export interface Crop {
  x: number;
  y: number;
  scale: number;
}

export interface ItemOption {
  id: string;
  /** Text shown on the option (text options, binary buttons). */
  label?: string;
  image_url?: string;
  artwork_id?: string;
  accent?: string;
  crop?: Crop;
  flip?: boolean;
  /** Revealed under the option once answered (e.g. "Roman · 120 AD"). */
  note?: string;
}

export interface ItemTarget {
  id: string;
  label: string;
}

export type RevealEffect = "none" | "zoom" | "blur" | "tiles";

export interface ItemMedia {
  /** Badge on the question card — the style's display name. */
  label: string;
  /** Main artwork image, when the question has one. */
  image_url?: string;
  artwork_id?: string;
  accent?: string;
  /** Speed styles: the main image starts hidden and reveals over time. */
  reveal?: RevealEffect;
  reveal_seconds?: number;
  /** Show only this window of the main image (detail match). */
  crop?: Crop;
  flip?: boolean;
  /** Missing piece: the square blacked out on the main image. */
  hole?: Crop;
  /** Text shown in place of an image (placard match). */
  caption?: string;
  /** Older / newer: the work the main image is compared against. */
  compare?: {
    image_url: string;
    artwork_id: string;
    accent?: string;
    label: string;
  };
  /** Clue ladder: shown one at a time (`reveal_seconds` apart). */
  clues?: string[];
  /** Keep the main image hidden until the player answers. */
  image_after_answer?: boolean;
  /** Multi: the player must pick exactly this many before submitting. */
  select_count?: number;
  /** Match: the drop targets each option is assigned to. */
  targets?: ItemTarget[];
  /** Unscramble: letter tiles. */
  letters?: string[];
  /** Type the answer: autocomplete list. */
  suggestions?: string[];
  /** Numeric slider range (must not give the answer away). */
  slider?: { min: number; max: number; step: number; unit?: string };
  /** How options are drawn. */
  options_as?: "text" | "image" | "tiles";
  /** Grid columns for image / tile options. */
  columns?: number;
}

/** single / multi / binary — ids of the correct option(s). */
export interface ChoiceAnswer {
  correct: string[];
}
/** order — option ids in the right order. */
export interface OrderAnswer {
  order: string[];
}
/** match — option id → target id. */
export interface MatchAnswer {
  pairs: Record<string, string>;
}
/** numeric — full points within `full_within`, none beyond `zero_beyond`. */
export interface NumericAnswer {
  value: number;
  full_within: number;
  zero_beyond: number;
  /** How to print the answer ("1642", "c. 120 BC"). */
  display: string;
}
/** text — any of these (normalised) counts as right. */
export interface TextAnswer {
  accept: string[];
  display: string;
}

export type ItemAnswer =
  | ChoiceAnswer
  | OrderAnswer
  | MatchAnswer
  | NumericAnswer
  | TextAnswer;

/** A built question, before it gets a database id. */
export interface QuizItemDraft {
  style: string;
  answer_type: AnswerType;
  prompt: string;
  media: ItemMedia;
  options: ItemOption[];
  answer: ItemAnswer;
  explain?: string;
  difficulty: Difficulty;
  /** Every artwork the question uses — for de-duplication and review links. */
  artwork_ids: string[];
}

// ── Style settings (drive the admin form) ─────────────────────────────────

export type SettingValue = number | boolean | string | string[];
export type StyleSettings = Record<string, SettingValue>;

export interface SettingChoice {
  value: string;
  label: string;
}

export type SettingField =
  | {
      key: string;
      label: string;
      type: "number";
      min: number;
      max: number;
      step?: number;
    }
  | { key: string; label: string; type: "boolean" }
  | { key: string; label: string; type: "select"; options: SettingChoice[] }
  | {
      key: string;
      label: string;
      type: "multiselect";
      options: SettingChoice[];
    };
