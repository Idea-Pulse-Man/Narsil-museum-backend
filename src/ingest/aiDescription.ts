/**
 * AI placard descriptions (OpenAI) — the last tier of the description pipeline.
 *
 * Tiering (see museum sources + backfillDescriptions.ts):
 *   0. Real museum prose is kept as-is — never rewritten.
 *   1. Thin records get deterministic wall text composed from fields.
 *   2. Only records still thin/boilerplate after that reach this module.
 *
 * The client requirement is "short and sweet and descriptive" with zero
 * AI-tell fluff, so the model is bounded by CODE, not trust:
 *   - ≤ 2 sentences, ≤ 45 words asked; a validator rejects > 65 words,
 *     banned marketing phrases, and refusal/meta text.
 *   - Grounded: the prompt forbids facts beyond the metadata we pass.
 *   - One retry naming the violation; second failure → null, and the caller
 *     keeps the deterministic text. AI can never make a placard worse.
 *
 * While OPENAI_API_KEY is unset every call resolves to null (tier disabled).
 */
import { env } from "../config/env.js";

// ── The gate: which descriptions deserve generation ─────────────────────────

/**
 * True when a stored description is too thin/boilerplate to stand as placard
 * prose. Good long museum text never matches — the client likes those.
 */
export function shouldGenerateAiDescription(description: string): boolean {
  const trimmed = description.trim();
  if (trimmed.length < 120) return true;
  // Legacy field dumps: "Artist · medium · 1858" (repeat the metadata grid).
  if (trimmed.includes(" · ")) return true;
  // Source boilerplate that says nothing about the work.
  if (/From the Wellcome Collection\.\s*$/.test(trimmed)) return true;
  if (/^1 photograph\./.test(trimmed)) return true;
  // Legacy ingest truncation that cut prose mid-sentence.
  if (/…$/.test(trimmed)) return true;
  return false;
}

// ── Generation input ────────────────────────────────────────────────────────

export interface AiDescriptionInput {
  title: string;
  artist: string;
  medium: string;
  year: string;
  museum: string;
  tags: string[];
  /** Whatever prose the source DID have (may be truncated/thin) — the model
   *  compresses these words rather than composing new ones. */
  sourceText?: string;
}

// ── Fluff validator (the mechanical "no AI-tell" guarantee) ─────────────────

/** Phrases that read as AI filler on a museum placard. Case-insensitive. */
const BANNED_PHRASES = [
  "invites the viewer",
  "invites viewers",
  "serves as a testament",
  "stands as a testament",
  "testament to",
  "rich tapestry",
  "timeless",
  "masterful",
  "masterfully",
  "evokes a sense of",
  "captures the essence",
  "a glimpse into",
  "delves into",
  "showcases the artist",
  "breathtaking",
  "stunning",
  "renowned for its beauty",
  "speaks to the",
  "reminds us",
  "one cannot help",
];

/** Refusal / meta text that must never reach a placard. */
const META_RE =
  /\b(as an ai|i cannot|i can't|i'm sorry|language model|here is a|here's a)\b/i;

const wordCount = (text: string): number =>
  text.split(/\s+/).filter(Boolean).length;

const sentenceCount = (text: string): number =>
  (text.match(/[.!?](\s|$)/g) ?? []).length || 1;

/**
 * Clean and validate a candidate. Returns the cleaned text, or the reason it
 * was rejected (used verbatim in the retry prompt).
 */
export function validateWallText(
  raw: string,
): { ok: true; text: string } | { ok: false; reason: string } {
  let text = raw
    .trim()
    // Strip wrapping quotes/markdown the model sometimes adds.
    .replace(/^["'“”\s]+|["'“”\s]+$/g, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return { ok: false, reason: "empty response" };
  if (META_RE.test(text)) return { ok: false, reason: "meta/refusal text" };
  if (/…$/.test(text) || !/[.!?]$/.test(text)) {
    return { ok: false, reason: "must end on a complete sentence" };
  }
  if (wordCount(text) > 65) {
    return { ok: false, reason: `too long (${wordCount(text)} words; max 45)` };
  }
  if (sentenceCount(text) > 3) {
    return { ok: false, reason: "more than 2–3 sentences" };
  }
  const lower = text.toLowerCase();
  const banned = BANNED_PHRASES.find((p) => lower.includes(p));
  if (banned) return { ok: false, reason: `banned phrase: "${banned}"` };

  return { ok: true, text };
}

// ── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You write museum placard wall text. Terse, factual, zero marketing language.

Rules:
- At most 2 sentences, at most 45 words total.
- Use ONLY the facts provided. If something is unknown, omit it — never pad or speculate.
- If source text is provided, compress ITS words; do not invent new claims.
- Order: what the work depicts → how it was made (medium/technique) → period or context, when known.
- Plain declarative sentences. No rhetorical questions, no praise adjectives, no "invites the viewer" style filler.
- Do not repeat the title verbatim; the placard already shows it.
- Output the placard text only — no quotes, no preamble.

Examples of the voice:
- "An allegorical engraving personifying Taste: a woman with bowls of fruit, joined by a monkey, a traditional emblem of appetite. The Latin inscription invokes Ceres, goddess of the harvest."
- "Still life of a Delft dish with crab and a roemer of wine, painted in oil with the sharp highlights typical of Dutch tabletop scenes."
- "Woodblock print of travellers crossing a mountain pass in rain, from a series on the Tōkaidō road stations."`;

function userPrompt(input: AiDescriptionInput, complaint?: string): string {
  const lines = [
    `Title: ${input.title}`,
    input.artist && input.artist !== "Unknown Artist"
      ? `Artist: ${input.artist}`
      : "",
    input.medium && input.medium !== "—" ? `Medium: ${input.medium}` : "",
    input.year && input.year !== "Date unknown" ? `Date: ${input.year}` : "",
    input.museum ? `Collection: ${input.museum}` : "",
    input.tags.length ? `Subject tags: ${input.tags.join(", ")}` : "",
    input.sourceText ? `Source text (compress this): ${input.sourceText}` : "",
  ].filter(Boolean);
  if (complaint) {
    lines.push(
      `Your previous attempt was rejected (${complaint}). Fix that and answer again.`,
    );
  }
  return lines.join("\n");
}

// ── OpenAI call ─────────────────────────────────────────────────────────────

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

async function chat(
  input: AiDescriptionInput,
  complaint?: string,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: env.openai.model,
        // Terseness is enforced by the prompt + validator; the token cap is a
        // cost backstop. (`max_completion_tokens` — the current param name;
        // some models reject the legacy `max_tokens`.)
        max_completion_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(input, complaint) },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        `  (AI description: OpenAI ${res.status} — ${body.slice(0, 200)})`,
      );
      return null;
    }
    const data = (await res.json()) as ChatResponse;
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.warn(
      `  (AI description: request failed — ${err instanceof Error ? err.message : err})`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate one validated placard description, or null (no key, API error, or
 * the validator rejected both attempts). Null means: keep deterministic text.
 */
export async function generateAiDescription(
  input: AiDescriptionInput,
): Promise<string | null> {
  if (!env.openai.apiKey) return null;

  let complaint: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await chat(input, complaint);
    if (raw == null) return null;
    const verdict = validateWallText(raw);
    if (verdict.ok) return verdict.text;
    complaint = verdict.reason;
  }
  return null;
}
