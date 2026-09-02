import { describe, expect, it } from "vitest";

import { loadFillers, loadLexiconFile, lexiconLanguages } from "./index.js";

describe("lexiconLanguages", () => {
  it("lists every shipped filler lexicon file", () => {
    const languages = lexiconLanguages();
    expect(languages).toContain("en");
    expect(languages).toContain("hi");
    expect(languages).toContain("hinglish");
    expect(languages).toEqual([...languages].sort());
  });
});

describe("loadLexiconFile", () => {
  it("reads a language's raw lexicon file", () => {
    const file = loadLexiconFile("en");
    expect(file?.language).toBe("en");
    expect(file?.entries.length).toBeGreaterThan(0);
    expect(file?.entries[0]).toHaveProperty("token");
    expect(file?.entries[0]).toHaveProperty("contextRule");
  });

  it("returns undefined for a language with no file", () => {
    expect(loadLexiconFile("zz-nope")).toBeUndefined();
  });
});

describe("loadFillers", () => {
  it("returns the flat token list for a language", () => {
    const tokens = loadFillers("en");
    expect(tokens).toContain("um");
    expect(tokens).toContain("uh");
  });

  it("returns tokens for languages beyond English", () => {
    expect(loadFillers("hi").length).toBeGreaterThan(0);
    expect(loadFillers("ta").length).toBeGreaterThan(0);
  });

  it("falls back to English for an unknown language", () => {
    expect(loadFillers("zz-nope")).toEqual(loadFillers("en"));
  });
});
