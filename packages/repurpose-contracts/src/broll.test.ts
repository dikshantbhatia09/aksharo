import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BROLL_LIMITS,
  BROLL_LLM_KIND,
  BROLL_TEMPLATE_VERSION,
  BrollMomentSchema,
  BrollOutputSchema,
  BrollRequestSchema,
  brollJobKey,
} from "./broll.js";

function fixture(name: string): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-only fixture names are local literals, not user-controlled paths
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", name), "utf8")) as Record<
    string,
    unknown
  >;
}

const REQUEST = fixture("ai-llm-broll-request.v1.json");
const OUTPUT = fixture("ai-llm-broll-output.v1.json");

// The same literals `apps/worker-ai/tests/test_broll_contracts.py` asserts.
const REQUEST_FIELDS = [
  "avoid",
  "language",
  "maxMoments",
  "minGapMs",
  "schemaVersion",
  "title",
  "words",
];
const MOMENT_FIELDS = ["endMs", "endWordId", "phrase", "score", "spoken", "startMs", "startWordId"];
const OUTPUT_FIELDS = ["moments", "schemaVersion", "source"];

describe("the ai.llm broll contract (2026-10-05)", () => {
  it("parses the shared fixtures, field for field", () => {
    expect(BrollRequestSchema.parse(REQUEST)).toEqual(REQUEST);
    expect(BrollOutputSchema.parse(OUTPUT)).toEqual(OUTPUT);
    expect(Object.keys(REQUEST).sort()).toEqual(REQUEST_FIELDS);
    expect(Object.keys(BrollRequestSchema.shape).sort()).toEqual(REQUEST_FIELDS);
    expect(Object.keys(BrollMomentSchema.shape).sort()).toEqual(MOMENT_FIELDS);
    expect(Object.keys(BrollOutputSchema.shape).sort()).toEqual(OUTPUT_FIELDS);
  });

  it("refuses what a producer and a consumer could disagree about", () => {
    const bad = [
      { ...REQUEST, extra: true },
      { ...REQUEST, schemaVersion: 2 },
      { ...REQUEST, words: [] },
      { ...REQUEST, words: [{ id: "zero", t: "x", s: 0, e: 1 }] },
      { ...REQUEST, words: [{ id: "0:0", t: "x", s: 10, e: 5 }] },
      { ...REQUEST, maxMoments: BROLL_LIMITS.maxMoments + 1 },
      { ...REQUEST, avoid: [{ startMs: 5, endMs: 5 }] },
      { ...REQUEST, language: " " },
    ];
    for (const request of bad) {
      expect(BrollRequestSchema.safeParse(request).success, JSON.stringify(request)).toBe(false);
    }
    const moments = OUTPUT["moments"] as Record<string, unknown>[];
    const first = moments[0] ?? {};
    const badOutputs = [
      { ...OUTPUT, source: "rules" },
      { ...OUTPUT, moments: [{ ...first, score: 11 }] },
      { ...OUTPUT, moments: [{ ...first, phrase: "x" }] },
      { ...OUTPUT, moments: [{ ...first, phrase: "y".repeat(BROLL_LIMITS.phraseMax + 1) }] },
      { ...OUTPUT, moments: Array.from({ length: BROLL_LIMITS.maxMoments + 1 }, () => first) },
    ];
    for (const output of badOutputs) {
      expect(BrollOutputSchema.safeParse(output).success, JSON.stringify(output)).toBe(false);
    }
    // No moments is an answer.
    expect(BrollOutputSchema.parse({ schemaVersion: 1, moments: [], source: "none" })).toEqual({
      schemaVersion: 1,
      moments: [],
      source: "none",
    });
  });

  it("keys one ask per clip shape and document revision", () => {
    expect(BROLL_LLM_KIND).toBe("broll");
    expect(BROLL_TEMPLATE_VERSION).toBe("broll@1");
    expect(brollJobKey("01JPR0JECT0000000000000000", 7)).toBe(
      "ai.llm:broll:01JPR0JECT0000000000000000:7",
    );
  });
});
