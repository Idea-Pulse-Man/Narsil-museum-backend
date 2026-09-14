/**
 * Admin quiz AI generation — grounded MCQs from catalog works for a topic.
 */
import { env } from "../config/env.js";
import type { Artwork, Artist } from "../types/domain.js";

export interface GenerateQuizInput {
  topicKind: "age" | "empire";
  topicId: string;
  topicTitle: string;
  difficulty: "apprentice" | "scholar" | "master";
  count: number;
  mode: string;
}

export interface GeneratedQuizQuestion {
  mode: string;
  artwork_id: string | null;
  prompt: string;
  options: string[];
  correct_index: number;
}

/** Minimal era keyword map (mirrors museum-app history eras). */
const AGE_KEYWORDS: Record<string, string[]> = {
  "ancient-egypt": ["egypt", "egyptian", "pharaoh", "nile", "ptolema"],
  "classical-antiquity": [
    "greek",
    "roman",
    "greece",
    "rome",
    "hellenist",
    "classical",
  ],
  medieval: ["medieval", "middle ages", "gothic", "byzantine", "romanesque"],
  renaissance: ["renaissance"],
  baroque: ["baroque", "rococo"],
  romanticism: ["romantic", "romanticism"],
  modern: ["impression", "realism", "19th"],
  modernism: ["modern", "cubism", "abstract", "surreal", "expression"],
  contemporary: ["contemporary", "21st", "postmodern"],
};

function matchesAge(art: Artwork, topicId: string): boolean {
  const keys = AGE_KEYWORDS[topicId];
  if (!keys?.length) {
    // Fallback: topic id words against period/tags/source.
    const blob = `${art.period} ${art.tags.join(" ")} ${art.source} ${art.empire ?? ""}`.toLowerCase();
    return topicId
      .split("-")
      .filter((w) => w.length > 2)
      .some((w) => blob.includes(w));
  }
  const blob = `${art.period} ${art.tags.join(" ")} ${art.source} ${art.empire ?? ""} ${art.title}`.toLowerCase();
  return keys.some((k) => blob.includes(k));
}

export function filterCatalogForTopic(
  artworks: Artwork[],
  topicKind: "age" | "empire",
  topicId: string,
): Artwork[] {
  return artworks.filter((art) => {
    if (!art.image) return false;
    if (topicKind === "empire") return art.empire === topicId;
    return matchesAge(art, topicId);
  });
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
}

function artistName(art: Artwork, artists: Map<string, Artist>): string {
  return artists.get(art.artistId)?.name ?? "Unknown";
}

function pickWorks(pool: Artwork[], count: number): Artwork[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, Math.max(count, Math.min(12, pool.length)));
}

function parseQuestions(raw: string, count: number): GeneratedQuizQuestion[] {
  let text = raw.trim();
  // Strip markdown fences if the model wraps JSON.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: GeneratedQuizQuestion[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const options = Array.isArray(row.options)
      ? row.options.map((o) => String(o).trim()).filter(Boolean)
      : [];
    if (options.length !== 4) continue;
    const prompt = String(row.prompt ?? "").trim();
    if (!prompt) continue;
    let correct = Number(row.correct_index);
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) correct = 0;
    out.push({
      mode: String(row.mode ?? "what"),
      artwork_id: row.artwork_id ? String(row.artwork_id) : null,
      prompt,
      options,
      correct_index: correct,
    });
    if (out.length >= count) break;
  }
  return out;
}

export async function generateQuizQuestions(
  input: GenerateQuizInput,
  artworks: Artwork[],
  artists: Artist[],
): Promise<GeneratedQuizQuestion[]> {
  if (!env.openai.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured on the server — cannot generate quiz questions.",
    );
  }

  const artistById = new Map(artists.map((a) => [a.id, a]));
  const pool = filterCatalogForTopic(
    artworks,
    input.topicKind,
    input.topicId,
  );
  if (pool.length < 3) {
    throw new Error(
      `Not enough catalog works for “${input.topicTitle}” (need at least 3 with images).`,
    );
  }

  const works = pickWorks(pool, Math.max(input.count, 6));
  const workLines = works
    .map((a) => {
      const name = artistName(a, artistById);
      return `- id=${a.id} | title="${a.title}" | artist="${name}" | year="${a.year}" | medium="${a.medium}" | period="${a.period}" | empire="${a.empire ?? ""}" | museum="${a.source}" | tags=${a.tags.slice(0, 6).join(",")}`;
    })
    .join("\n");

  const modeRule =
    input.mode && input.mode !== "auto"
      ? `Every question must use mode "${input.mode}".`
      : `Mix modes from: what, who, age, where, medium, period, museum, subject.`;

  const system = `You write multiple-choice museum quiz questions for Narsil.
Rules:
- Use ONLY the artworks listed. Never invent titles, artists, dates, or museums.
- Each question must reference one artwork_id from the list (for the image).
- Exactly 4 options; exactly one correct. Put the correct answer at correct_index (0-3).
- Distractors must be plausible but wrong, drawn from OTHER listed works when possible.
- Prompt should be a clear question a museum visitor could answer from the image + knowledge.
- ${modeRule}
- Output ONLY a JSON array of objects with keys: mode, artwork_id, prompt, options (array of 4 strings), correct_index (number).
- No markdown, no commentary.`;

  const user = `Topic: ${input.topicTitle} (${input.topicKind} / ${input.topicId})
Difficulty: ${input.difficulty}
Generate exactly ${input.count} questions.

Artworks:
${workLines}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
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
        max_completion_tokens: 4000,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 240)}`);
    }
    const data = (await res.json()) as ChatResponse;
    const content = data.choices?.[0]?.message?.content ?? "";
    const questions = parseQuestions(content, input.count);

    // Ensure artwork_id is from our pool; drop orphans.
    const allowed = new Set(works.map((w) => w.id));
    return questions
      .map((q) => ({
        ...q,
        artwork_id:
          q.artwork_id && allowed.has(q.artwork_id)
            ? q.artwork_id
            : works[0]?.id ?? null,
      }))
      .slice(0, input.count);
  } finally {
    clearTimeout(timer);
  }
}
