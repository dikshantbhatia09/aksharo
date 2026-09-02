import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { charCount, detectWordScript, dominantScript, limitsFor, SCRIPT_LIMITS } from "./script.js";
import { DEFAULT_SEGMENTER_PARAMS, segmentScript, segmentWords, wrapLines } from "./segmenter.js";
import { buildGolden, GOLDEN_PATH } from "../../scripts/build-segmenter-golden.js";
import { type Word } from "../schemas/transcript.js";

interface GoldenSegment {
  id: string;
  seq: string;
  startWordId: string;
  endWordId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  speaker?: string;
  lines: string[];
  lineChars: number[];
  cps: number;
}

interface GoldenCase {
  name: string;
  language: string;
  script: keyof typeof SCRIPT_LIMITS;
  limits: { maxCharsPerLine: number; maxCps: number };
  words: Word[];
  expected: GoldenSegment[];
}

const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as {
  params: typeof DEFAULT_SEGMENTER_PARAMS;
  cases: GoldenCase[];
};

function words(specs: readonly Partial<Word>[]): Word[] {
  return specs.map((spec, index) => ({
    wid: (spec.wid ?? `0:${index}`) as Word["wid"],
    s: spec.s ?? index * 500,
    e: spec.e ?? index * 500 + 450,
    t: spec.t ?? "word",
    ...(spec.sp === undefined ? {} : { sp: spec.sp }),
    ...(spec.filler === undefined ? {} : { filler: spec.filler }),
    ...(spec.deleted === undefined ? {} : { deleted: spec.deleted }),
  }));
}

function ids(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `SEG${String(counter).padStart(3, "0")}`;
  };
}

describe("the committed golden fixtures", () => {
  it("still describes what the segmenter produces", () => {
    expect({ params: DEFAULT_SEGMENTER_PARAMS, cases: buildGolden() }).toEqual(golden);
  });

  it("covers Roman Hinglish, Devanagari Hindi and Tamil", () => {
    expect(golden.cases.map((entry) => entry.script)).toEqual(["latin", "devanagari", "tamil"]);
    expect(golden.cases.map((entry) => entry.limits.maxCharsPerLine)).toEqual([32, 24, 22]);
  });

  for (const entry of golden.cases) {
    describe(entry.name, () => {
      it("respects the line length, line count and reading speed of its script", () => {
        for (const segment of entry.expected) {
          expect(segment.lines.length, `${segment.id} lines`).toBeLessThanOrEqual(
            DEFAULT_SEGMENTER_PARAMS.maxLines,
          );
          for (const [index, chars] of segment.lineChars.entries()) {
            expect(
              chars,
              `${segment.id} line ${index}: ${segment.lines[index] ?? ""}`,
            ).toBeLessThanOrEqual(entry.limits.maxCharsPerLine);
          }
          expect(segment.cps, `${segment.id} cps`).toBeLessThanOrEqual(entry.limits.maxCps);
          expect(segment.durationMs, `${segment.id} duration`).toBeGreaterThanOrEqual(
            DEFAULT_SEGMENTER_PARAMS.minMs,
          );
          expect(segment.durationMs, `${segment.id} duration`).toBeLessThanOrEqual(
            DEFAULT_SEGMENTER_PARAMS.maxMs,
          );
        }
      });

      it("covers every word exactly once, in order", () => {
        const covered = entry.expected.flatMap((segment) => {
          const from = entry.words.findIndex((word) => word.wid === segment.startWordId);
          const to = entry.words.findIndex((word) => word.wid === segment.endWordId);
          return entry.words.slice(from, to + 1).map((word) => word.wid);
        });
        expect(covered).toEqual(entry.words.map((word) => word.wid));
      });

      it("never puts two speakers in one caption", () => {
        for (const segment of entry.expected) {
          const from = entry.words.findIndex((word) => word.wid === segment.startWordId);
          const to = entry.words.findIndex((word) => word.wid === segment.endWordId);
          const speakers = new Set(entry.words.slice(from, to + 1).map((word) => word.sp));
          expect(speakers.size).toBe(1);
        }
      });
    });
  }
});

describe("segmentWords", () => {
  it("returns nothing for an empty transcript", () => {
    expect(segmentWords([])).toEqual([]);
  });

  it("is deterministic given the same ids", () => {
    const input = golden.cases[0]?.words ?? [];
    expect(segmentWords(input, {}, { newId: ids() })).toEqual(
      segmentWords(input, {}, { newId: ids() }),
    );
  });

  it("breaks when the speaker changes, even mid-sentence", () => {
    const input = words([
      { t: "one", sp: "a", s: 0, e: 400 },
      { t: "two", sp: "a", s: 450, e: 850 },
      { t: "three", sp: "b", s: 900, e: 1300 },
      { t: "four", sp: "b", s: 1350, e: 1750 },
    ]);
    const segments = segmentWords(input, { minMs: 0 }, { newId: ids() });
    expect(segments.map((segment) => [segment.startWordId, segment.endWordId])).toEqual([
      ["0:0", "0:1"],
      ["0:2", "0:3"],
    ]);
  });

  it("never breaks on a pause shorter than mergeGapMs", () => {
    const input = words([
      { t: "aa", s: 0, e: 400 },
      { t: "bb", s: 440, e: 840 },
      { t: "cc", s: 880, e: 1280 },
      { t: "dd", s: 1320, e: 1720 },
    ]);
    expect(segmentWords(input, {}, { newId: ids() })).toHaveLength(1);
  });

  it("breaks on a pause of at least mergeGapMs once the caption is long enough", () => {
    const input = words([
      { t: "aa", s: 0, e: 400 },
      { t: "bb", s: 440, e: 840 },
      { t: "cc", s: 1100, e: 1900 },
    ]);
    const segments = segmentWords(input, {}, { newId: ids() });
    expect(segments.map((segment) => segment.endWordId)).toEqual(["0:1", "0:2"]);
  });

  it("breaks after sentence-final punctuation in any script", () => {
    const input = words([
      { t: "एक", s: 0, e: 400 },
      { t: "दो।", s: 440, e: 840 },
      { t: "तीन", s: 880, e: 1280 },
      { t: "चार", s: 1320, e: 1720 },
    ]);
    const segments = segmentWords(input, {}, { newId: ids() });
    expect(segments.map((segment) => segment.endWordId)).toEqual(["0:1", "0:3"]);
  });

  it("breaks before a word that would need a third line", () => {
    const input = words(
      Array.from({ length: 8 }, (_, index) => ({
        t: "abcdefghijklmnopqrst",
        s: index * 500,
        e: index * 500 + 450,
      })),
    );
    const segments = segmentWords(input, { maxChars: 20, maxLines: 2 }, { newId: ids() });
    expect(segments).toHaveLength(4);
    for (const segment of segments) {
      const from = input.findIndex((word) => word.wid === segment.startWordId);
      const to = input.findIndex((word) => word.wid === segment.endWordId);
      expect(
        wrapLines(
          input.slice(from, to + 1).map((word) => word.t),
          20,
        ).length,
      ).toBeLessThanOrEqual(2);
    }
  });

  it("breaks before a word that would run past maxMs", () => {
    // `cc` is long enough that no rebalancing can pair it with `bb` either — the
    // break is the maxMs limit and nothing else.
    const input = words([
      { t: "aa", s: 0, e: 1000 },
      { t: "bb", s: 1040, e: 2000 },
      { t: "cc", s: 2040, e: 3600 },
    ]);
    const segments = segmentWords(input, { maxMs: 2500 }, { newId: ids() });
    expect(segments.map((segment) => segment.endWordId)).toEqual(["0:1", "0:2"]);
  });

  it("breaks before a word that would push the reading speed past the ceiling", () => {
    const input = words([
      { t: "abcdefghij", s: 0, e: 700 },
      { t: "klmnopqrst", s: 740, e: 900 },
      { t: "uvwxyzabcd", s: 940, e: 1100 },
    ]);
    const segments = segmentWords(input, { maxCps: 20, minMs: 0, maxLines: 4 }, { newId: ids() });
    expect(segments.length).toBeGreaterThan(1);
  });

  it("absorbs a caption below minMs into the neighbour that can take it", () => {
    const input = words([
      { t: "aa", s: 0, e: 200 },
      { t: "bb", s: 260, e: 1400 },
      { t: "cc", s: 1460, e: 2600 },
    ]);
    // The first word alone is 200 ms; it must not survive as its own caption.
    const segments = segmentWords(input, {}, { newId: ids() });
    expect(segments[0]?.startWordId).toBe("0:0");
    expect(segments[0] ? segments[0].endMs - segments[0].startMs : 0).toBeGreaterThanOrEqual(700);
  });

  it("leaves a short caption alone when no neighbour can take it", () => {
    const input = words([
      { t: "aa", sp: "a", s: 0, e: 200 },
      { t: "bb", sp: "b", s: 260, e: 1400 },
    ]);
    const segments = segmentWords(input, {}, { newId: ids() });
    expect(segments).toHaveLength(2);
  });

  it("skips tombstoned words always and fillers on request", () => {
    const input = words([
      { t: "aa", s: 0, e: 400 },
      { t: "matlab", s: 440, e: 840, filler: true },
      { t: "cc", s: 880, e: 1280, deleted: true },
      { t: "dd", s: 1320, e: 1720 },
    ]);
    expect(segmentWords(input, {}, { newId: ids() })[0]).toMatchObject({
      startWordId: "0:0",
      endWordId: "0:3",
    });
    const dropped = segmentWords(input, {}, { newId: ids(), dropFillers: true });
    const from = dropped[0]?.startWordId;
    expect(from).toBe("0:0");
    expect(dropped.map((segment) => segment.endWordId)).toEqual(["0:3"]);
    expect(segmentWords([{ ...input[2] } as Word], {}, { newId: ids() })).toEqual([]);
  });

  it("hands a forced break's single-word caption a word from the caption before it", () => {
    // Four words of eleven characters at maxChars 12: the greedy pass fills three
    // lines' worth into one caption and leaves the fourth word on its own.
    const input = words([
      { t: "aaaaaaaaaaa", s: 0, e: 800 },
      { t: "bbbbbbbbbbb", s: 840, e: 1640 },
      { t: "ccccccccccc", s: 1680, e: 2480 },
      { t: "ddddddddddd", s: 2520, e: 3320 },
    ]);
    const plain = segmentWords(input, { maxChars: 12, maxLines: 2 }, { newId: ids() });
    expect(plain.map((segment) => [segment.startWordId, segment.endWordId])).toEqual([
      ["0:0", "0:1"],
      ["0:2", "0:3"],
    ]);

    // Three words: the third would need a third line, so it is orphaned — and the
    // caption before it can spare its last word.
    const three = segmentWords(input.slice(0, 3), { maxChars: 12, maxLines: 2 }, { newId: ids() });
    expect(three.map((segment) => [segment.startWordId, segment.endWordId])).toEqual([
      ["0:0", "0:0"],
      ["0:1", "0:2"],
    ]);
  });

  it("leaves a one-word caption alone when the donation would break a limit", () => {
    // Donating `bb` would put a 2 600 ms caption on screen, past maxMs.
    const input = words([
      { t: "aa", s: 0, e: 1000 },
      { t: "bb", s: 1040, e: 2000 },
      { t: "cc", s: 2040, e: 3600 },
    ]);
    expect(segmentWords(input, { maxMs: 2500 }, { newId: ids() }).map((s) => s.endWordId)).toEqual([
      "0:1",
      "0:2",
    ]);
  });

  it("leaves a one-word caption alone when the donor would fall below minMs", () => {
    const input = words([
      { t: "aaaaaaaaaaa", s: 0, e: 400 },
      { t: "bbbbbbbbbbb", s: 440, e: 840 },
      { t: "ccccccccccc", s: 880, e: 1600 },
    ]);
    // Handing `bb` down would leave `aa` as a 400 ms caption.
    const segments = segmentWords(
      input,
      { maxChars: 12, maxLines: 2, mergeGapMs: 1_000 },
      { newId: ids() },
    );
    expect(segments.map((segment) => [segment.startWordId, segment.endWordId])).toEqual([
      ["0:0", "0:1"],
      ["0:2", "0:2"],
    ]);
  });

  it("never rebalances across a speaker change or a preferred break", () => {
    const speakers = words([
      { t: "aaaaaaaaaaa", sp: "a", s: 0, e: 800 },
      { t: "bbbbbbbbbbb", sp: "a", s: 840, e: 1640 },
      { t: "ccccccccccc", sp: "b", s: 1680, e: 2480 },
    ]);
    expect(
      segmentWords(speakers, { maxChars: 12, maxLines: 2 }, { newId: ids() }).map((segment) => [
        segment.startWordId,
        segment.endWordId,
      ]),
    ).toEqual([
      ["0:0", "0:1"],
      ["0:2", "0:2"],
    ]);

    // A full stop is the speaker's own boundary, so "Bilkul." stays a caption.
    const sentence = words([
      { t: "chalo", s: 0, e: 800 },
      { t: "shuru", s: 840, e: 1640 },
      { t: "karte.", s: 1680, e: 2480 },
      { t: "Bilkul", s: 2520, e: 3320 },
    ]);
    expect(
      segmentWords(sentence, {}, { newId: ids() }).map((segment) => segment.endWordId),
    ).toEqual(["0:2", "0:3"]);
  });

  it("stamps a styleRef when one is supplied", () => {
    const input = words([{ t: "aa", s: 0, e: 900 }]);
    expect(segmentWords(input, {}, { newId: ids(), styleRef: "punch-pop" })[0]?.styleRef).toBe(
      "punch-pop",
    );
    expect(segmentWords(input, {}, { newId: ids() })[0]?.styleRef).toBeUndefined();
  });

  it("mints ULIDs when no id factory is supplied", () => {
    const segments = segmentWords(words([{ t: "aa", s: 0, e: 900 }]));
    expect(segments[0]?.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("reports the script its limits came from", () => {
    expect(segmentScript(words([{ t: "hello" }]))).toBe("latin");
    expect(segmentScript(words([{ t: "नमस्ते" }]))).toBe("devanagari");
  });
});

describe("wrapLines", () => {
  it("greedily fills lines and never splits a word", () => {
    expect(wrapLines(["aaaa", "bbbb", "cccccccc"], 9)).toEqual(["aaaa bbbb", "cccccccc"]);
    expect(wrapLines(["averylongsingleword"], 5)).toEqual(["averylongsingleword"]);
    expect(wrapLines([], 10)).toEqual([]);
  });
});

describe("script detection", () => {
  it("classifies a word by the block most of its letters live in", () => {
    expect(detectWordScript("editing")).toBe("latin");
    expect(detectWordScript("करेंगे")).toBe("devanagari");
    expect(detectWordScript("பேசுவோம்")).toBe("tamil");
    expect(detectWordScript("مرحبا")).toBe("other");
    expect(detectWordScript("বাংলা")).toBe("other");
    expect(detectWordScript("2024")).toBeUndefined();
    expect(detectWordScript("—")).toBe("other");
  });

  it("gives a mixed run to the script with the most letters", () => {
    expect(dominantScript(["video", "editing", "करेंगे"])).toBe("latin");
    expect(dominantScript(["करेंगे", "बात", "video"])).toBe("devanagari");
    expect(dominantScript([])).toBe("latin");
    expect(dominantScript(["123", "!!"])).toBe("latin");
  });

  it("counts characters as base code points, not combining marks", () => {
    expect(charCount("editing")).toBe(7);
    expect(charCount("करेंगे")).toBe(3);
    expect(charCount("")).toBe(0);
  });

  it("publishes the limit table from 09 §3", () => {
    expect(SCRIPT_LIMITS).toEqual({
      latin: { maxCharsPerLine: 32, maxCps: 20 },
      devanagari: { maxCharsPerLine: 24, maxCps: 15 },
      tamil: { maxCharsPerLine: 22, maxCps: 15 },
      other: { maxCharsPerLine: 26, maxCps: 15 },
    });
    expect(limitsFor("tamil").maxCharsPerLine).toBe(22);
  });
});
