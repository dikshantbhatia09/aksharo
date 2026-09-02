import { describe, expect, it } from "vitest";

import {
  fontStackForLanguage,
  indicFontHref,
  INDIC_FONT_FAMILIES,
  INDIC_SCRIPTS,
  loadIndicFont,
  scriptForLanguage,
} from "./indic";

describe("scriptForLanguage", () => {
  it("maps the Indian languages onto their scripts", () => {
    expect(scriptForLanguage("hi")).toBe("devanagari");
    expect(scriptForLanguage("mr-IN")).toBe("devanagari");
    expect(scriptForLanguage("ta")).toBe("tamil");
    expect(scriptForLanguage("pa")).toBe("gurmukhi");
  });

  it("treats the Roman transliteration of Hindi as Devanagari's language", () => {
    // "hi-Latn" is Hinglish: the base subtag decides the face to preload, so a
    // Hinglish transcript that switches to native script has the font already.
    expect(scriptForLanguage("hi-Latn")).toBe("devanagari");
  });

  it("is undefined for Latin", () => {
    expect(scriptForLanguage("en")).toBeUndefined();
    expect(scriptForLanguage("")).toBeUndefined();
  });
});

describe("indicFontHref", () => {
  it("asks Google Fonts for the two weights the UI uses, with display=swap", () => {
    expect(indicFontHref("tamil")).toBe(
      "https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;600&display=swap",
    );
  });

  it("covers every script the pipeline can produce", () => {
    expect(Object.keys(INDIC_FONT_FAMILIES).sort()).toEqual([...INDIC_SCRIPTS].sort());
  });
});

describe("loadIndicFont", () => {
  it("inserts the stylesheet once", () => {
    const doc = document.implementation.createHTMLDocument("test");
    expect(loadIndicFont("bengali", doc)).toBe(true);
    expect(loadIndicFont("bengali", doc)).toBe(false);
    expect(doc.querySelectorAll("link[rel=stylesheet]")).toHaveLength(1);
    expect(doc.getElementById("aksharo-font-bengali")).not.toBeNull();
  });
});

describe("fontStackForLanguage", () => {
  it("puts the Noto family in front of the UI stack", () => {
    expect(fontStackForLanguage("kn")).toBe('"Noto Sans Kannada", var(--font-sans)');
  });

  it("stays on the UI stack for Latin", () => {
    expect(fontStackForLanguage("en-IN")).toBe("var(--font-sans)");
  });
});
