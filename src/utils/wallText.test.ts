import { describe, expect, it } from "vitest";
import { composeWallText } from "./wallText.js";

describe("composeWallText", () => {
  it("composes placard sentences from fields", () => {
    expect(
      composeWallText({
        artistName: "Prosper Crébassol",
        medium: "oil on canvas",
        yearLabel: "1858",
        museum: "The Rijksmuseum, Amsterdam",
      }),
    ).toBe("Oil on canvas by Prosper Crébassol, 1858. The Rijksmuseum, Amsterdam.");
  });

  it("ignores placeholders and unknown artists", () => {
    expect(
      composeWallText({ artistName: "Unknown Artist", medium: "—", yearLabel: "Date unknown" }),
    ).toBe("");
    expect(composeWallText({ artistName: "Unknown Artist", medium: "etching" })).toBe("Etching.");
  });

  it("drops vocabulary qualifiers that repeat the medium", () => {
    expect(composeWallText({ medium: "paint on canvas, oil paint (paint)" })).toBe(
      "Paint on canvas, oil paint.",
    );
  });
});
