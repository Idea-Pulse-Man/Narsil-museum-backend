import { describe, expect, it } from "vitest";
import { buildQuizCatalog, parseYear, type ArtistRow, type ArtworkRow } from "./catalog.js";
import { buildItems } from "./generate.js";
import { scoreResponse, normalizeText } from "./scoring.js";
import { STYLE_BUILDERS } from "./styles/index.js";
import { maskPlacard } from "./styles/choice.js";
import type { NumericAnswer, QuizItemDraft } from "./types.js";
import { fingerprint, validateItem } from "./validate.js";

const ARTISTS = [
  "Claude Monet",
  "Rembrandt van Rijn",
  "Katsushika Hokusai",
  "Johannes Vermeer",
  "Caravaggio Merisi",
  "Edgar Degas",
  "Titian Vecellio",
  "Albrecht Durer",
  "Workshop of Rubens",
];
const PERIODS = ["Impressionism", "Baroque", "Edo Period", "Renaissance"];
const EMPIRES = ["Roman", "Greek", "Egyptian", "Etruscan"];
const SUBJECTS = ["Landscape", "Portrait", "Still life", "Seascape"];
const MEDIA = ["Oil on canvas", "Marble", "Woodblock print", "Bronze"];

function fakeCatalog() {
  const artists: ArtistRow[] = ARTISTS.map((name, i) => ({
    id: `artist-${i}`,
    name,
    nationality: ["French", "Dutch", "Japanese", "Italian"][i % 4]!,
  }));
  const rows: ArtworkRow[] = [];
  for (let i = 0; i < 96; i++) {
    const a = i % ARTISTS.length;
    const sculpture = i % 3 === 0;
    rows.push({
      id: `art-${i}`,
      title: `${["The Starry", "Water", "Night", "Harbour", "Morning", "Garden"][i % 6]} ${["River", "Lilies", "Watch", "Light", "Bridge", "Study"][(i * 7) % 6]} ${i}`,
      image_url: `https://img.example/art-${i}.jpg`,
      artist_id: `artist-${a}`,
      year: i % 10 === 0 ? `${100 + i} BC` : String(1400 + ((i * 37) % 520)),
      period: PERIODS[i % PERIODS.length]!,
      medium: MEDIA[i % MEDIA.length]!,
      source: ["The Met", "Rijksmuseum", "Cleveland Museum of Art"][i % 3]!,
      accent: "#334455",
      tags: [SUBJECTS[i % SUBJECTS.length]!],
      category: sculpture ? "sculptures" : "paintings",
      empire: sculpture ? EMPIRES[i % EMPIRES.length]! : null,
      hidden: i === 95,
      description: `This celebrated work by ${ARTISTS[a]} shows a quiet scene painted with care. Critics praise its light and its colour, and it has hung in the gallery for many years. Visitors return to it again and again.`,
      ai_description: null,
      like_count: (i * 13) % 40,
    });
  }
  return buildQuizCatalog(rows, artists);
}

describe("quiz catalog", () => {
  it("skips hidden works and generic makers", () => {
    const catalog = fakeCatalog();
    expect(catalog.byId.has("art-95")).toBe(false);
    expect(catalog.artistNames).not.toContain("Workshop of Rubens");
  });

  it("parses display years", () => {
    expect(parseYear("1642")).toBe(1642);
    expect(parseYear("c. 1650–55")).toBe(1650);
    expect(parseYear("120 BC")).toBe(-120);
    expect(parseYear("17th century")).toBe(1650);
    expect(parseYear("")).toBeNull();
  });
});

describe("every style builds valid questions", () => {
  const catalog = fakeCatalog();
  for (const builder of STYLE_BUILDERS) {
    it(builder.id, () => {
      const { items, problems } = buildItems(builder, builder.defaults, catalog, 5, `test:${builder.id}`);
      expect(problems).toEqual([]);
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(validateItem(item)).toEqual([]);
        expect(item.style).toBe(builder.id);
        expect(item.answer_type).toBe(builder.answerType);
      }
    });
  }

  it("is deterministic for a seed", () => {
    const b = STYLE_BUILDERS[1]!;
    const one = buildItems(b, b.defaults, catalog, 3, "seed").items;
    const two = buildItems(b, b.defaults, catalog, 3, "seed").items;
    expect(one.map(fingerprint)).toEqual(two.map(fingerprint));
  });

  it("year slider never centres the answer on the slider", () => {
    const b = STYLE_BUILDERS.find((s) => s.id === "year_slider")!;
    const { items } = buildItems(b, b.defaults, catalog, 10, "slider");
    for (const item of items) {
      const a = item.answer as NumericAnswer;
      const { min, max } = item.media.slider!;
      expect(min).toBeLessThan(a.value);
      expect(max).toBeGreaterThan(a.value);
    }
  });

  it("hides names on placards", () => {
    const art = catalog.byId.get("art-1")!;
    const text = maskPlacard(art);
    expect(text).not.toContain(art.artistName);
  });
});

describe("validator", () => {
  const base: QuizItemDraft = {
    style: "classic",
    answer_type: "single",
    prompt: "Who made this?",
    media: { label: "Artist", image_url: "https://x/y.jpg" },
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
    answer: { correct: ["a"] },
    difficulty: "scholar",
    artwork_ids: ["art-1"],
  };

  it("accepts a good item", () => {
    expect(validateItem(base)).toEqual([]);
  });

  it("rejects an answer that points nowhere", () => {
    expect(validateItem({ ...base, answer: { correct: ["z"] } })).not.toEqual([]);
  });

  it("rejects duplicate labels and unknown answer types", () => {
    expect(
      validateItem({ ...base, options: [...base.options.slice(0, 2), { id: "c", label: "a" }] }),
    ).not.toEqual([]);
    expect(validateItem({ ...base, answer_type: "map" as never })).not.toEqual([]);
  });

  it("rejects a slider that doesn't contain the answer", () => {
    expect(
      validateItem({
        ...base,
        answer_type: "numeric",
        options: [],
        media: { label: "Year", slider: { min: 1500, max: 1600, step: 1 } },
        answer: { value: 1700, full_within: 10, zero_beyond: 100, display: "1700" },
      }),
    ).not.toEqual([]);
  });
});

describe("scoring", () => {
  it("single / binary", () => {
    expect(scoreResponse("single", { correct: ["b"] }, { kind: "choice", ids: ["b"] }).correct).toBe(true);
    expect(scoreResponse("binary", { correct: ["b"] }, { kind: "choice", ids: ["a"] }).correct).toBe(false);
  });

  it("multi gives partial credit, needs the exact set", () => {
    const r = scoreResponse("multi", { correct: ["a", "b"] }, { kind: "choice", ids: ["a"] });
    expect(r.correct).toBe(false);
    expect(r.fraction).toBe(0.5);
    expect(scoreResponse("multi", { correct: ["a", "b"] }, { kind: "choice", ids: ["b", "a"] }).correct).toBe(true);
    expect(scoreResponse("multi", { correct: ["a", "b"] }, { kind: "choice", ids: ["a", "b", "c"] }).correct).toBe(false);
  });

  it("order and match", () => {
    expect(scoreResponse("order", { order: ["c", "a", "b"] }, { kind: "order", ids: ["c", "a", "b"] }).correct).toBe(true);
    expect(scoreResponse("order", { order: ["c", "a", "b"] }, { kind: "order", ids: ["a", "c", "b"] }).fraction).toBeCloseTo(1 / 3);
    expect(
      scoreResponse("match", { pairs: { a: "t1", b: "t2" } }, { kind: "match", pairs: { a: "t1", b: "t1" } }).fraction,
    ).toBe(0.5);
  });

  it("numeric distance", () => {
    const answer = { value: 1642, full_within: 10, zero_beyond: 110, display: "1642" };
    expect(scoreResponse("numeric", answer, { kind: "numeric", value: 1650 }).fraction).toBe(1);
    expect(scoreResponse("numeric", answer, { kind: "numeric", value: 1702 }).fraction).toBeCloseTo(0.5);
    expect(scoreResponse("numeric", answer, { kind: "numeric", value: 1800 }).correct).toBe(false);
  });

  it("text ignores case, accents and punctuation", () => {
    expect(normalizeText("  Albrecht DÜRER! ")).toBe("albrecht durer");
    expect(
      scoreResponse("text", { accept: ["Albrecht Dürer", "Dürer"], display: "Albrecht Dürer" }, { kind: "text", value: "durer" }).correct,
    ).toBe(true);
  });
});
