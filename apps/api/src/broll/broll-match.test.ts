import { describe, expect, it } from "vitest";

import {
  bestPicture,
  MIN_MATCH,
  normaliseTag,
  normaliseTags,
  pictureScore,
  spokenTags,
  type LibraryPicture,
} from "./broll-match.js";

function picture(id: string, tags: readonly string[], shape = { width: 1440, height: 2560 }) {
  return { id, tags, title: null, format: "jpeg", ...shape } satisfies LibraryPicture;
}

const TAJ = picture("01JPX0000000000000000000T1", ["taj mahal"]);
const TAJ_WIDE = picture("01JPX0000000000000000000T2", ["taj mahal agra"], {
  width: 2560,
  height: 1440,
});
const CHAI = picture("01JPX0000000000000000000C1", ["masala chai", "tea"]);
const BEACH = { ...picture("01JPX0000000000000000000B1", []), title: "Goa beach at sunset" };

describe("normaliseTag", () => {
  it("lower-cases, drops punctuation and squeezes the spaces", () => {
    expect(normaliseTag("  Taj-Mahal!! ")).toBe("taj mahal");
    expect(normaliseTag("MASALA   Chai")).toBe("masala chai");
    // Devanagari keeps its vowel signs: they are part of the word.
    expect(normaliseTag("ताज महल")).toBe("ताज महल");
  });

  it("keeps a picture's tags unique, non-empty and bounded", () => {
    expect(normaliseTags(["Chai", "chai", " ", "Tea!", "x".repeat(60)], 3, 40)).toEqual([
      "chai",
      "tea",
      "x".repeat(40),
    ]);
  });
});

describe("pictureScore", () => {
  it("is 1 for a tag that is the phrase, 0.9 for one said word for word", () => {
    expect(pictureScore(TAJ, "Taj Mahal", "")).toBe(1);
    expect(pictureScore(TAJ, "white marble monument", "humne Taj Mahal dekha")).toBe(0.9);
    expect(pictureScore(TAJ_WIDE, "taj mahal", "")).toBe(0.8);
  });

  it("reads the title's words too, and needs most of the phrase to be there", () => {
    expect(pictureScore(BEACH, "goa beach", "")).toBeGreaterThanOrEqual(MIN_MATCH);
    expect(pictureScore(BEACH, "mumbai beach traffic", "")).toBeLessThan(MIN_MATCH);
    // "the" says nothing about a picture.
    expect(pictureScore(CHAI, "the tea", "")).toBe(0.9);
  });

  it("is 0 for a picture about something else", () => {
    expect(pictureScore(CHAI, "taj mahal", "Taj Mahal dekha")).toBe(0);
  });
});

describe("bestPicture", () => {
  it("keeps the best match, and nothing when none is good enough", () => {
    const library = [CHAI, TAJ, BEACH];
    expect(bestPicture(library, { phrase: "taj mahal", spoken: "" })?.id).toBe(TAJ.id);
    expect(bestPicture(library, { phrase: "red fort", spoken: "Lal Qila" })).toBeUndefined();
  });

  it("prefers a picture the clip has not used, then one shaped like the frame", () => {
    const twin = picture("01JPX0000000000000000000T3", ["taj mahal"], {
      width: 2560,
      height: 1440,
    });
    const library = [twin, TAJ];
    const moment = { phrase: "taj mahal", spoken: "" };
    // Tall frame: the portrait photo, though the landscape one is newer.
    expect(bestPicture(library, moment, { canvas: { width: 1080, height: 1920 } })?.id).toBe(
      TAJ.id,
    );
    expect(bestPicture(library, moment, { canvas: { width: 1920, height: 1080 } })?.id).toBe(
      twin.id,
    );
    // Already used: the other one, whatever its shape.
    expect(
      bestPicture(library, moment, {
        canvas: { width: 1080, height: 1920 },
        used: new Set([TAJ.id]),
      })?.id,
    ).toBe(twin.id);
  });
});

describe("spokenTags", () => {
  const words = ["Kal", "hum", "Taj", "Mahal", "gaye", "aur", "masala", "chai", "pee", "tea"].map(
    (t, index) => ({ wid: `0:${String(index)}`, s: index * 500, e: index * 500 + 400, t }),
  );

  it("finds every tag said word for word, on its own words", () => {
    const found = spokenTags(words, [TAJ, CHAI]);
    expect(found.map((entry) => [entry.phrase, entry.startWordId, entry.endWordId])).toEqual([
      ["taj mahal", "0:2", "0:3"],
      ["masala chai", "0:6", "0:7"],
    ]);
    expect(found.every((entry) => entry.score >= 6)).toBe(true);
    expect(found.map((entry) => entry.pictureId)).toEqual([TAJ.id, CHAI.id]);
  });

  it("leaves out a one-word tag too short to trust", () => {
    // "tea" is said, but a three-letter word is too easy to hear by chance.
    expect(spokenTags(words, [picture("01JPX0000000000000000000E1", ["tea"])])).toEqual([]);
  });
});
