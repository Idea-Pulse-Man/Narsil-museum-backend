/**
 * Phase 6 — AI description generation (deferred).
 *
 * When enabled, call an OpenAI-compatible API during ingest for thin/synthetic
 * placards and store the result in `artworks.ai_description`. Not wired in v1.
 */
export function shouldGenerateAiDescription(description: string): boolean {
  const trimmed = description.trim();
  if (trimmed.length < 120) return true;
  if (/From the Wellcome Collection\.\s*$/.test(trimmed)) return true;
  if (/^1 photograph\./.test(trimmed)) return true;
  return false;
}

/** Placeholder — returns null until an API key and provider are configured. */
export async function generateAiDescription(_input: {
  title: string;
  artist: string;
  medium: string;
  tags: string[];
}): Promise<string | null> {
  return null;
}
