/**
 * Every generated item passes through here before it is saved. A builder bug
 * produces a rejected item and a log line — never a broken question in the app.
 */
import { createHash } from "node:crypto";
import {
  ANSWER_TYPES,
  DIFFICULTIES,
  type ChoiceAnswer,
  type MatchAnswer,
  type NumericAnswer,
  type OrderAnswer,
  type QuizItemDraft,
  type TextAnswer,
} from "./types.js";

const isUrl = (v: unknown) => typeof v === "string" && /^https?:\/\//.test(v);

/** Problems with `item`; empty when it is safe to publish. */
export function validateItem(item: QuizItemDraft): string[] {
  const errors: string[] = [];
  const fail = (msg: string) => errors.push(msg);

  if (!ANSWER_TYPES.includes(item.answer_type)) {
    fail(`unknown answer type "${item.answer_type}"`);
    return errors;
  }
  if (!DIFFICULTIES.includes(item.difficulty)) fail("bad difficulty");
  const prompt = item.prompt?.trim() ?? "";
  if (prompt.length < 1 || prompt.length > 500) fail("prompt length");
  if (!item.media?.label) fail("missing media.label");
  if (item.media.image_url !== undefined && !isUrl(item.media.image_url)) {
    fail("media.image_url is not a URL");
  }
  if (item.artwork_ids.length === 0) fail("no artwork ids");

  const ids = item.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) fail("duplicate option ids");
  for (const o of item.options) {
    if (!o.label && !o.image_url) fail(`option ${o.id} has no label or image`);
    if (o.image_url !== undefined && !isUrl(o.image_url)) {
      fail(`option ${o.id} image is not a URL`);
    }
  }
  const labels = item.options
    .filter((o) => o.label && !o.image_url)
    .map((o) => o.label!.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) fail("duplicate option labels");

  const idSet = new Set(ids);
  switch (item.answer_type) {
    case "single":
    case "binary":
    case "multi": {
      const correct = (item.answer as ChoiceAnswer).correct ?? [];
      const min = item.answer_type === "binary" ? 2 : 3;
      if (item.options.length < min) fail("too few options");
      if (item.answer_type === "binary" && item.options.length !== 2) {
        fail("binary needs exactly 2 options");
      }
      if (item.answer_type !== "multi" && correct.length !== 1) {
        fail("needs exactly one correct option");
      }
      if (item.answer_type === "multi") {
        if (correct.length < 1) fail("multi needs a correct option");
        if (correct.length >= item.options.length) fail("multi: every option correct");
      }
      if (!correct.every((id) => idSet.has(id))) fail("answer points at a missing option");
      break;
    }
    case "order": {
      const order = (item.answer as OrderAnswer).order ?? [];
      if (order.length < 3) fail("order needs 3+ items");
      if (order.length !== ids.length || !order.every((id) => idSet.has(id))) {
        fail("order must list every option once");
      }
      if (new Set(order).size !== order.length) fail("order repeats an option");
      break;
    }
    case "match": {
      const pairs = (item.answer as MatchAnswer).pairs ?? {};
      const targets = new Set((item.media.targets ?? []).map((t) => t.id));
      if (targets.size < 2) fail("match needs 2+ targets");
      if (Object.keys(pairs).length !== ids.length) fail("every option needs a pair");
      for (const [k, v] of Object.entries(pairs)) {
        if (!idSet.has(k)) fail(`pair key ${k} is not an option`);
        if (!targets.has(v)) fail(`pair target ${v} is missing`);
      }
      break;
    }
    case "numeric": {
      const a = item.answer as NumericAnswer;
      const s = item.media.slider;
      if (!Number.isFinite(a.value)) fail("numeric value");
      if (!(a.full_within >= 0 && a.zero_beyond > a.full_within)) fail("numeric tolerance");
      if (!s || !(s.min < a.value && a.value < s.max)) fail("slider must contain the answer");
      break;
    }
    case "text": {
      const a = item.answer as TextAnswer;
      if (!a.accept?.length || a.accept.some((x) => !x.trim())) fail("text accept list");
      if (!a.display?.trim()) fail("text display");
      break;
    }
  }
  return errors;
}

/** Stable identity of a question — the unique key that stops duplicates. */
export function fingerprint(item: QuizItemDraft): string {
  const key = JSON.stringify([
    item.style,
    [...item.artwork_ids].sort(),
    item.prompt.trim().toLowerCase(),
    item.answer,
  ]);
  return createHash("sha1").update(key).digest("hex");
}
