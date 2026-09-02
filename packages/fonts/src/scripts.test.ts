import { describe, expect, it } from "vitest";

import {
  COMMON_RANGES,
  COVERAGE_THRESHOLD,
  coverageRatio,
  coveredScripts,
  expandRanges,
  isScriptTag,
  REQUIRED_SCRIPTS,
  requiredCodePoints,
  SCHEDULED_LANGUAGES,
  SCRIPT_NAMES,
  SCRIPT_RANGES,
  SCRIPT_SAMPLES,
  SCRIPT_TAGS,
  scriptsOfCodePoint,
  subsetCodePoints,
  subsetText,
  toWordScript,
  toWordScripts,
} from "./scripts.js";

describe("the scheduled languages", () => {
  it("names all 22 of the Eighth Schedule", () => {
    expect(SCHEDULED_LANGUAGES).toHaveLength(22);
    expect(new Set(SCHEDULED_LANGUAGES.map((l) => l.code)).size).toBe(22);
  });

  it("gives every language a script the catalogue knows", () => {
    for (const language of SCHEDULED_LANGUAGES) {
      expect(isScriptTag(language.script), `${language.name} → ${language.script}`).toBe(true);
    }
  });

  it("requires Latin plus every scheduled script, and nothing else", () => {
    const fromLanguages = new Set(SCHEDULED_LANGUAGES.map((l) => l.script));
    expect(new Set(REQUIRED_SCRIPTS)).toEqual(new Set(["Latn", ...fromLanguages]));
    // The twelve Indic/Arabic scripts of the 22 languages, plus Latin.
    expect(REQUIRED_SCRIPTS).toHaveLength(13);
  });

  it("has a sample and a name for every tag", () => {
    for (const tag of SCRIPT_TAGS) {
      expect(SCRIPT_NAMES[tag]).toBeTruthy();
      expect(SCRIPT_SAMPLES[tag].length).toBeGreaterThan(2);
    }
  });

  it("writes each sample in the script it names", () => {
    for (const tag of SCRIPT_TAGS) {
      if (tag === "Latn") continue;
      const inScript = [...SCRIPT_SAMPLES[tag]].filter((character) => {
        const code = character.codePointAt(0) ?? 0;
        return scriptsOfCodePoint(code).includes(tag);
      });
      expect(inScript.length, `${tag} sample`).toBeGreaterThan(2);
    }
  });
});

describe("script ranges", () => {
  it("gives every tag at least one range and one required set", () => {
    for (const tag of SCRIPT_TAGS) {
      expect(SCRIPT_RANGES[tag].length).toBeGreaterThan(0);
      expect(requiredCodePoints(tag).length).toBeGreaterThan(0);
    }
  });

  it("keeps every required code point inside the script's own ranges", () => {
    for (const tag of SCRIPT_TAGS) {
      for (const code of requiredCodePoints(tag)) {
        expect(scriptsOfCodePoint(code), `U+${code.toString(16)} of ${tag}`).toContain(tag);
      }
    }
  });

  it("expands ranges without duplicates and in order", () => {
    const points = expandRanges([
      [10, 12],
      [11, 13],
    ]);
    expect(points).toEqual([10, 11, 12, 13]);
  });

  it("always keeps the shaping controls and the rupee sign", () => {
    const common = new Set(expandRanges(COMMON_RANGES));
    for (const code of [0x20, 0x2e, 0x30, 0x200c, 0x200d, 0x20b9, 0x2026]) {
      expect(common.has(code), `U+${code.toString(16)}`).toBe(true);
    }
  });

  it("adds the common set to every subset", () => {
    const deva = new Set(subsetCodePoints(["Deva"]));
    expect(deva.has(0x0915)).toBe(true); // क
    expect(deva.has(0x0041)).toBe(true); // A — a Hinglish caption needs both
    expect(deva.has(0x0b95)).toBe(false); // க is Tamil and not asked for
  });

  it("turns a subset into text without lone surrogates", () => {
    const text = subsetText(["Taml"]);
    expect(text.length).toBeGreaterThan(200);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
    expect(text).toContain("க");
  });
});

describe("coverage", () => {
  const full = (tag: (typeof SCRIPT_TAGS)[number]): Set<number> => new Set(requiredCodePoints(tag));

  it("scores a complete repertoire at 1", () => {
    expect(coverageRatio("Taml", full("Taml"))).toBe(1);
  });

  it("scores an empty character map at 0", () => {
    expect(coverageRatio("Deva", new Set())).toBe(0);
  });

  it("finds the scripts a character map covers", () => {
    expect(coveredScripts(full("Beng"))).toEqual(["Beng"]);
    expect(coveredScripts(new Set([...full("Latn"), ...full("Deva")]))).toEqual(["Latn", "Deva"]);
  });

  it("refuses a script a font only dabbles in", () => {
    const required = requiredCodePoints("Knda");
    const half = new Set(required.slice(0, Math.floor(required.length / 2)));
    expect(coverageRatio("Knda", half)).toBeLessThan(COVERAGE_THRESHOLD);
    expect(coveredScripts(half)).not.toContain("Knda");
  });

  it("tolerates a font missing one or two characters of a block", () => {
    const required = requiredCodePoints("Taml");
    const nearlyAll = new Set(required.slice(0, required.length - 1));
    expect(coveredScripts(nearlyAll)).toContain("Taml");
  });
});

describe("the WordScript bridge", () => {
  it("narrows to the segmenter's four values and never widens", () => {
    expect(toWordScript("Latn")).toBe("latin");
    expect(toWordScript("Deva")).toBe("devanagari");
    expect(toWordScript("Taml")).toBe("tamil");
    for (const tag of SCRIPT_TAGS) {
      if (["Latn", "Deva", "Taml"].includes(tag)) continue;
      expect(toWordScript(tag), tag).toBe("other");
    }
  });

  it("de-duplicates and orders the hints for a face", () => {
    expect(toWordScripts(["Beng", "Latn", "Orya"])).toEqual(["latin", "other"]);
    expect(toWordScripts(["Deva", "Latn"])).toEqual(["latin", "devanagari"]);
  });

  it("rejects anything that is not a known tag", () => {
    expect(isScriptTag("Hans")).toBe(false);
    expect(isScriptTag(42)).toBe(false);
    expect(isScriptTag(undefined)).toBe(false);
  });
});
