import { describe, expect, it } from "vitest";

import { ALL_LANGUAGES, DESI_LANGUAGES, languageLabel, OTHER_LANGUAGES } from "./languages";

describe("languages.ts — the one source of truth (K02 acceptance criterion 1)", () => {
  it("has no duplicate keys", () => {
    const keys = ALL_LANGUAGES.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("includes Nepali, Urdu and Pushto", () => {
    const keys = ALL_LANGUAGES.map((entry) => entry.key);
    expect(keys).toEqual(expect.arrayContaining(["ne", "ur", "ps"]));
  });

  it("splits cleanly into Desi & Regional and everything else", () => {
    expect(DESI_LANGUAGES.length + OTHER_LANGUAGES.length).toBe(ALL_LANGUAGES.length);
    expect(DESI_LANGUAGES.every((entry) => entry.group === "desi")).toBe(true);
    expect(OTHER_LANGUAGES.every((entry) => entry.group === "other")).toBe(true);
  });

  it("puts the brief's own Desi & Regional example set first, in order", () => {
    expect(DESI_LANGUAGES.map((entry) => entry.key)).toEqual([
      "hi-Latn",
      "en-IN",
      "en",
      "bn",
      "hi",
      "mr",
      "ne",
    ]);
  });

  it("resolves a label, falling back to the tag for an unknown one", () => {
    expect(languageLabel("hi")).toBe("हिन्दी");
    expect(languageLabel("xx-unknown")).toBe("xx-unknown");
  });
});
