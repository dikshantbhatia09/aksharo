import { describe, expect, it } from "vitest";

import type { TranscriptChunk, Word } from "@montaj/edg/schemas";
import { DEFAULT_SEGMENTER_PARAMS, segmentWords } from "@montaj/edg/segmenter";

import {
  aspectOf,
  budgetsForMeta,
  canvasAspectFor,
  fitCapFor,
  resolveBudgets,
} from "./caption-budgets.js";
import {
  CAPTION_BOUNDS,
  DEFAULT_STYLE_REF,
  edgInitInputFor,
  segmenterParamsFor,
  speakersFrom,
} from "./transcript-init.js";


function chunk(words: Word[], chunkIdx = 0): TranscriptChunk {
  return {
    chunkIdx,
    startMs: words[0]?.s ?? 0,
    endMs: words[words.length - 1]?.e ?? 0,
    words,
  };
}

function word(n: number, text: string, sp?: string): Word {
  return {
    wid: `0:${String(n)}` as Word["wid"],
    s: n * 500,
    e: n * 500 + 450,
    t: text,
    ...(sp === undefined ? {} : { sp }),
  };
}

const CHUNKS = [
  chunk([
    word(0, "Bhai", "SPEAKER_02"),
    word(1, "aaj", "SPEAKER_02"),
    word(2, "haan", "SPEAKER_01"),
  ]),
];

describe("edgInitInputFor", () => {
  it("hands EdgService.initialise the transcript facts and the 09 §3 defaults", () => {
    const input = edgInitInputFor({
      transcriptId: "01JCTRANSCRIPT0000000000000",
      language: "hi-Latn",
      scripts: ["roman", "native"],
      chunks: CHUNKS,
    });

    expect(input).toMatchObject({
      transcriptId: "01JCTRANSCRIPT0000000000000",
      language: "hi-Latn",
      scripts: ["roman", "native"],
      dropFillers: true,
      styleRef: DEFAULT_STYLE_REF,
      author: null,
      source: "worker",
    });
    // Nothing overridden, so the segmenter's own per-script table applies.
    expect(input.segmenter).toBeUndefined();
  });

  it("derives the speakers from the words when none are supplied", () => {
    expect(
      edgInitInputFor({
        transcriptId: "T",
        language: "hi-Latn",
        scripts: ["roman"],
        chunks: CHUNKS,
      }).speakers,
    ).toEqual([{ id: "SPEAKER_02" }, { id: "SPEAKER_01" }]);
  });

  it("prefers the speakers post-processing already normalised", () => {
    expect(
      edgInitInputFor({
        transcriptId: "T",
        language: "hi-Latn",
        scripts: ["roman"],
        chunks: CHUNKS,
        speakers: [{ id: "s1" }, { id: "s2" }],
      }).speakers,
    ).toEqual([{ id: "s1" }, { id: "s2" }]);
  });

  it("omits speakers entirely for an undiarised transcript", () => {
    const undiarised = [chunk([word(0, "one"), word(1, "two")])];
    expect(
      edgInitInputFor({
        transcriptId: "T",
        language: "en",
        scripts: ["roman"],
        chunks: undiarised,
      }).speakers,
    ).toBeUndefined();
    expect(speakersFrom(undiarised)).toEqual([]);
  });

  it("falls back to `roman` rather than an empty script list", () => {
    expect(
      edgInitInputFor({ transcriptId: "T", language: "en", scripts: [], chunks: CHUNKS }).scripts,
    ).toEqual(["roman"]);
  });

  it("passes the workspace's caption preferences through", () => {
    const input = edgInitInputFor({
      transcriptId: "T",
      language: "en",
      scripts: ["roman"],
      chunks: CHUNKS,
      preferences: { maxLines: 1, dropFillers: false, styleRef: "punch-pop" },
    });
    expect(input.segmenter).toEqual({ maxLines: 1 });
    expect(input.dropFillers).toBe(false);
    expect(input.styleRef).toBe("punch-pop");
  });
});

describe("segmenterParamsFor", () => {
  it("leaves every unset limit to the segmenter's own defaults", () => {
    expect(segmenterParamsFor({})).toEqual({});
  });

  it("clamps a preference that would make captions unreadable", () => {
    const params = segmenterParamsFor({ maxLines: 99, maxChars: 1, minMs: 0, maxMs: 999_999 });
    expect(params.maxLines).toBe(CAPTION_BOUNDS.maxLines.max);
    expect(params.maxChars).toBe(CAPTION_BOUNDS.maxChars.min);
    expect(params.minMs).toBe(CAPTION_BOUNDS.minMs.min);
    expect(params.maxMs).toBe(CAPTION_BOUNDS.maxMs.max);
  });

  it("never lets minMs cross maxMs", () => {
    const crossed = segmenterParamsFor({ minMs: 3_000, maxMs: 1_000 });
    expect(crossed.minMs).toBeLessThanOrEqual(crossed.maxMs ?? Number.POSITIVE_INFINITY);
  });

  it("ignores a preference that is not a number", () => {
    expect(segmenterParamsFor({ maxLines: Number.NaN }).maxLines).toBe(CAPTION_BOUNDS.maxLines.min);
  });

  it("produces params the segmenter actually accepts", () => {
    const params = segmenterParamsFor({ maxLines: 2, maxChars: 30, minMs: 800, maxMs: 5_000 });
    const segments = segmentWords(CHUNKS[0]?.words ?? [], {
      ...DEFAULT_SEGMENTER_PARAMS,
      ...params,
    });
    expect(segments.length).toBeGreaterThan(0);
  });
});

describe("caption budgets (D78)", () => {
  it("is the readability cap until A16d's fitBudget is wired in", () => {
    const budgets = resolveBudgets({ script: "latin", aspect: "r9x16" });
    expect(budgets).toMatchObject({
      maxChars: 32,
      maxLines: 2,
      script: "latin",
      aspect: "9:16",
      source: "readability",
      readabilityChars: 32,
    });
    expect(budgets.canvas).toEqual({ width: 1080, height: 1920 });
  });

  it("uses the script's own readability cap: 32 / 24 / 22", () => {
    expect(resolveBudgets({ script: "latin" }).maxChars).toBe(32);
    expect(resolveBudgets({ script: "devanagari" }).maxChars).toBe(24);
    expect(resolveBudgets({ script: "tamil" }).maxChars).toBe(22);
    expect(resolveBudgets({ script: "other" }).maxChars).toBe(26);
  });

  it("lets a workspace preference narrow the budget but never widen it", () => {
    expect(resolveBudgets({ script: "latin", preferences: { maxChars: 20 } }).maxChars).toBe(20);
    expect(resolveBudgets({ script: "latin", preferences: { maxChars: 60 } }).maxChars).toBe(32);
    expect(resolveBudgets({ script: "latin", preferences: { maxLines: 1 } }).maxLines).toBe(1);
    expect(resolveBudgets({ script: "latin", preferences: { maxLines: 3 } }).maxLines).toBe(2);
  });

  it("takes the canvas from the project's chosen aspect", () => {
    expect(resolveBudgets({ script: "latin", aspect: "r16x9" }).canvas).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(resolveBudgets({ script: "latin", aspect: "r4x5" }).aspect).toBe("4:5");
  });

  it("lets landscape footage override the untouched 9:16 default, and nothing else", () => {
    // The default plus landscape media: the probe wins.
    expect(canvasAspectFor("r9x16", { width: 1920, height: 1080 })).toBe("16:9");
    // The default plus portrait media, or no probe at all: the default stands.
    expect(canvasAspectFor("r9x16", { width: 1080, height: 1920 })).toBe("9:16");
    expect(canvasAspectFor("r9x16", { width: null, height: null })).toBe("9:16");
    expect(canvasAspectFor("r9x16")).toBe("9:16");
    // A chosen aspect is never second-guessed.
    expect(canvasAspectFor("r1x1", { width: 1920, height: 1080 })).toBe("1:1");
    expect(aspectOf(null)).toBe("9:16");
    expect(aspectOf("r4x5")).toBe("4:5");
  });

  it("has one switch point for A16d, and it is honest about being absent", () => {
    expect(
      fitCapFor({
        script: "latin",
        aspect: "9:16",
        canvas: { width: 1080, height: 1920 },
        styleRef: "clean-bold",
      }),
    ).toBeUndefined();
  });

  it("records what it used, so A15 can offer a reflow", () => {
    const budgets = resolveBudgets({ script: "devanagari", aspect: "r9x16" });
    const meta = budgetsForMeta(budgets);
    expect(meta["segmenter"]).toBe("readability@1");
    expect(JSON.parse(meta["captionBudgets"] ?? "{}")).toEqual({
      maxChars: 24,
      maxLines: 2,
      script: "devanagari",
      aspect: "9:16",
      styleRef: "clean-bold",
      source: "readability",
      readabilityChars: 24,
    });
  });

  it("passes the budget to the segmenter and records it on the document", () => {
    const budgets = resolveBudgets({ script: "tamil" });
    const input = edgInitInputFor({
      transcriptId: "T",
      language: "ta",
      scripts: ["native"],
      chunks: CHUNKS,
      budgets,
    });
    expect(input.segmenter).toMatchObject({ maxChars: 22, maxLines: 2 });
    expect(input.engineVersions).toMatchObject({ segmenter: "readability@1" });
  });
});
