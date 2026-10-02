import { describe, expect, it } from "vitest";
import { shouldGenerateAiDescription, validateWallText } from "./aiDescription.js";

const LONG_PROSE =
  "A large altarpiece painted for a chapel in Ghent, showing the adoration of the lamb " +
  "surrounded by saints, prophets and pilgrims in a meadow full of carefully observed plants.";

describe("shouldGenerateAiDescription", () => {
  it("leaves real museum prose alone", () => {
    expect(shouldGenerateAiDescription(LONG_PROSE)).toBe(false);
  });

  it("flags thin, dumped, boilerplate and truncated text", () => {
    expect(shouldGenerateAiDescription("Oil on canvas.")).toBe(true);
    expect(shouldGenerateAiDescription(`Rembrandt · oil on canvas · 1642 ${LONG_PROSE}`)).toBe(true);
    expect(shouldGenerateAiDescription(`${LONG_PROSE} From the Wellcome Collection.`)).toBe(true);
    expect(shouldGenerateAiDescription(`${LONG_PROSE.slice(0, 150)}…`)).toBe(true);
  });
});

describe("validateWallText", () => {
  it("accepts and cleans a good placard", () => {
    expect(
      validateWallText('  "Woodblock print of travellers crossing a pass in rain."  '),
    ).toEqual({
      ok: true,
      text: "Woodblock print of travellers crossing a pass in rain.",
    });
  });

  it("rejects refusals, unfinished text and banned phrases", () => {
    expect(validateWallText("As an AI, I cannot describe this.").ok).toBe(false);
    expect(validateWallText("A portrait of a merchant in").ok).toBe(false);
    expect(validateWallText("A stunning view of Delft.").ok).toBe(false);
  });

  it("rejects text over 65 words and says so", () => {
    const verdict = validateWallText(`${"word ".repeat(70).trim()}.`);
    expect(verdict).toEqual({ ok: false, reason: "too long (70 words; max 45)" });
  });

  it("does not count abbreviations as sentence ends", () => {
    const text =
      "View of St. Louis from the river, painted ca. 1850 by J. C. Wild. " +
      "The city is shown from the Illinois bank.";
    expect(validateWallText(text)).toEqual({ ok: true, text });
  });

  it("still rejects more than three real sentences", () => {
    const text = "One fact. Two facts. Three facts. Four facts.";
    expect(validateWallText(text).ok).toBe(false);
  });
});
