/**
 * Style registry. Adding a style = one builder here + one seed row in
 * museum-app/supabase/quiz-engine.sql. If it reuses an existing answer type,
 * the app needs no update.
 */
import { classic } from "./classic.js";
import { findPair, oddOneOut, pickImage, placardMatch, selectAll } from "./choice.js";
import {
  blurReveal,
  detailMatch,
  intruderTile,
  missingPiece,
  mirror,
  tileReveal,
  zoomReveal,
} from "./visual.js";
import { matchPairs, matchPeriod, sortGroups, timeline } from "./ordering.js";
import { beforeAfter, moreLoved, olderNewer, yearSlider } from "./numbers.js";
import {
  clueLadder,
  fillTitle,
  trueFalse,
  twoTruths,
  typeArtist,
  unscramble,
} from "./words.js";
import type { StyleBuilder } from "./shared.js";

export type { StyleBuilder, BuildContext } from "./shared.js";

export const STYLE_BUILDERS: StyleBuilder[] = [
  classic,
  pickImage,
  selectAll,
  oddOneOut,
  findPair,
  placardMatch,
  detailMatch,
  zoomReveal,
  blurReveal,
  tileReveal,
  mirror,
  intruderTile,
  missingPiece,
  timeline,
  matchPairs,
  matchPeriod,
  sortGroups,
  yearSlider,
  beforeAfter,
  olderNewer,
  moreLoved,
  trueFalse,
  twoTruths,
  fillTitle,
  typeArtist,
  unscramble,
  clueLadder,
];

export const STYLE_BY_ID: Record<string, StyleBuilder> = Object.fromEntries(
  STYLE_BUILDERS.map((b) => [b.id, b]),
);

/** What the admin panel needs to draw each style's settings form. */
export function describeStyles() {
  return STYLE_BUILDERS.map((b) => ({
    id: b.id,
    label: b.label,
    answer_type: b.answerType,
    description: b.description,
    surfaces: b.surfaces,
    settings: b.settings,
    defaults: b.defaults,
  }));
}
