import { describe, expect, it } from "vitest";

import type { Word } from "@montaj/edg/schemas";

import {
  applyGlossary,
  buildGlossaryIndex,
} from "../transcripts/postprocess/glossary.js";

import type { GlossaryTerm } from "../transcripts/postprocess/glossary.js";

/**
 * Acceptance #2: "matcher tests: >= 95% precision on the fixture (no incorrect
 * replacements) with recall reported."
 *
 * This exercises the matcher A11 already built (`transcripts/postprocess/glossary.ts`)
 * against the entries B09 writes — the same `{term, aliases, source}` shape
 * `MemoryGlossarySource` reads out of `memory_entries`. B09 does not own or
 * change the matcher itself (it is A11's), only the fixture that pins its
 * behaviour on the Hinglish/Devanagari vocabulary B09's glossary and spelling
 * memory entries are expected to contain.
 */
function word(t: string, wid = "0:0"): Word {
  return { wid: wid as `${number}:${number}`, s: 0, e: 100, t };
}

/** Glossary/spelling memory entries a workspace might plausibly have stored. */
const TERMS: GlossaryTerm[] = [
  { term: "Aksharo", aliases: ["Akshero", "Acsharo"], source: "glossary" },
  { term: "Sarvam", source: "glossary" },
  { term: "Bharat", source: "spelling" },
  { term: "प्रियंका", source: "spelling" },
  { term: "श्रेया", aliases: ["श्रेय़ा"], source: "spelling" },
  { term: "Crestmond", aliases: ["Crest Mond"], source: "glossary" },
];

const index = buildGlossaryIndex(TERMS);

/** Positives: a heard spelling that should resolve to the canonical term. */
const POSITIVES: readonly { heard: string; expected: string }[] = [
  { heard: "Akshara", expected: "Aksharo" },
  { heard: "Akshero", expected: "Aksharo" },
  { heard: "Sarwam", expected: "Sarvam" },
  { heard: "Bharath", expected: "Bharat" },
  { heard: "प्रियांका", expected: "प्रियंका" },
  { heard: "श्रेय़ा", expected: "श्रेया" },
  { heard: "Crestmund", expected: "Crestmond" },
];

/**
 * Negatives: common words that must NOT be rewritten — including near-misses
 * chosen because they sit close to a term phonetically/orthographically. Any
 * rewrite here is a false positive and fails the precision bar.
 */
const NEGATIVES: readonly string[] = [
  "editing",
  "sharp",
  "caption",
  "video",
  "Bihar",
  "Sarah",
  "भारत",
  "प्रिय",
  "मेरा",
  "shram",
  "Crest",
  "condiment",
  "Aksharo", // already correct — must be left alone, not "corrected" to itself noisily
  "Sarvam", // already correct
];

describe("glossary/spelling matcher precision (B09 fixture over A11's matcher)", () => {
  it("resolves every positive to its canonical spelling", () => {
    for (const { heard, expected } of POSITIVES) {
      const result = applyGlossary([word(heard)], index);
      expect(result.words[0]?.t, `"${heard}" should resolve to "${expected}"`).toBe(expected);
    }
  });

  it("never rewrites a negative (>= 95% precision, 0 false positives on this fixture)", () => {
    const falsePositives: string[] = [];
    for (const heard of NEGATIVES) {
      const result = applyGlossary([word(heard)], index);
      if (result.words[0]?.t !== heard) falsePositives.push(heard);
    }
    expect(falsePositives).toEqual([]);

    const precision = (NEGATIVES.length - falsePositives.length) / NEGATIVES.length;
    expect(precision).toBeGreaterThanOrEqual(0.95);
  });

  it("reports recall over the positive fixture", () => {
    let resolved = 0;
    for (const { heard, expected } of POSITIVES) {
      const result = applyGlossary([word(heard)], index);
      if (result.words[0]?.t === expected) resolved += 1;
    }
    const recall = resolved / POSITIVES.length;
     
    console.info(`glossary matcher recall on B09 fixture: ${(recall * 100).toFixed(1)}%`);
    expect(recall).toBeGreaterThanOrEqual(0.85);
  });
});
