import { describe, expect, it } from "vitest";

import {
  ClipTrimRequestSchema,
  formatSecToTimecode,
  parseTimecodeToSec,
  quantizeToFrame,
  sliceTranscriptLines,
  sliceTranscriptWords,
  snapToWordBoundary,
  type TimedWord,
} from "./transcript-slice.js";

const SAMPLE_WORDS: readonly TimedWord[] = [
  { id: "w1", text: "Wait", start: 10.0, end: 10.4 },
  { id: "w2", text: "for", start: 10.45, end: 10.7 },
  { id: "w3", text: "this", start: 10.75, end: 11.1 },
  { id: "w4", text: "punchline.", start: 11.15, end: 11.8, isSentenceEnd: true },
  { id: "w5", text: "Nobody", start: 12.8, end: 13.3 },
  { id: "w6", text: "saw", start: 13.35, end: 13.65 },
  { id: "w7", text: "it", start: 13.7, end: 13.9 },
  { id: "w8", text: "coming!", start: 13.95, end: 14.5, isSentenceEnd: true },
];

describe("sliceTranscriptWords", () => {
  it("filters words overlapping [startSec, endSec] and computes clip-relative offsets", () => {
    const sliced = sliceTranscriptWords(SAMPLE_WORDS, 10.45, 13.65);
    expect(sliced.map((w) => w.id)).toEqual(["w2", "w3", "w4", "w5", "w6"]);
    expect(sliced[0]!.clipRelativeStart).toBeCloseTo(0, 3);
    expect(sliced[0]!.clipRelativeEnd).toBeCloseTo(0.25, 3);
    expect(sliced[4]!.clipRelativeStart).toBeCloseTo(2.9, 3);
    expect(sliced[4]!.clipRelativeEnd).toBeCloseTo(3.2, 3);
  });

  it("clamps negative relative start offsets to 0 when a word spans across startSec", () => {
    const sliced = sliceTranscriptWords(SAMPLE_WORDS, 10.2, 11.0);
    expect(sliced).toHaveLength(3);
    expect(sliced[0]!.id).toBe("w1");
    expect(sliced[0]!.clipRelativeStart).toBe(0);
    expect(sliced[0]!.clipRelativeEnd).toBeCloseTo(0.2, 3);
  });

  it("includes words spanning across endSec", () => {
    const sliced = sliceTranscriptWords(SAMPLE_WORDS, 10.8, 11.3);
    expect(sliced.map((w) => w.id)).toEqual(["w3", "w4"]);
    expect(sliced[1]!.clipRelativeStart).toBeCloseTo(0.35, 3);
    expect(sliced[1]!.clipRelativeEnd).toBeCloseTo(1.0, 3);
  });

  it("returns empty array for inverted or non-finite bounds", () => {
    expect(sliceTranscriptWords(SAMPLE_WORDS, 15, 10)).toEqual([]);
    expect(sliceTranscriptWords(SAMPLE_WORDS, Number.NaN, 12)).toEqual([]);
    expect(sliceTranscriptWords([], 0, 10)).toEqual([]);
  });
});

describe("sliceTranscriptLines", () => {
  it("groups sliced words into subtitle lines with pause and sentence breaks", () => {
    const lines = sliceTranscriptLines(SAMPLE_WORDS, 10.0, 14.5);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.text).toBe("Wait for this punchline.");
    expect(lines[0]!.clipRelativeStartSec).toBe(0);
    expect(lines[0]!.clipRelativeEndSec).toBeCloseTo(1.8, 2);
    expect(lines[1]!.text).toBe("Nobody saw it coming!");
    expect(lines[1]!.clipRelativeStartSec).toBeCloseTo(2.8, 2);
    expect(lines[1]!.clipRelativeEndSec).toBeCloseTo(4.5, 2);
  });
});

describe("snapToWordBoundary & quantizeToFrame", () => {
  it("magnetically snaps to the nearest word start or end within ±0.2s", () => {
    const startSnap = snapToWordBoundary(10.58, SAMPLE_WORDS, "start");
    expect(startSnap.snapped).toBe(true);
    expect(startSnap.timeSec).toBe(10.45);
    expect(startSnap.snappedWordId).toBe("w2");

    const endSnap = snapToWordBoundary(11.95, SAMPLE_WORDS, "end");
    expect(endSnap.snapped).toBe(true);
    expect(endSnap.timeSec).toBe(11.8);
    expect(endSnap.snappedWordId).toBe("w4");
    expect(endSnap.snappedSentenceBoundary).toBe(true);
  });

  it("bypasses magnetic snapping on Shift-drag and quantizes to 1/30s frame precision", () => {
    const bypassed = snapToWordBoundary(10.46, SAMPLE_WORDS, "start", {
      bypassSnap: true,
      fps: 30,
    });
    expect(bypassed.snapped).toBe(false);
    expect(bypassed.snappedWordId).toBeNull();
    expect(bypassed.timeSec).toBe(Number((314 / 30).toFixed(6)));
  });

  it("validates ClipTrimRequestSchema", () => {
    expect(ClipTrimRequestSchema.safeParse({ startSec: 128.5, endSec: 175.0 }).success).toBe(true);
    expect(
      ClipTrimRequestSchema.safeParse({ startSec: 10, endSec: 20, bypassSnap: true }).success,
    ).toBe(true);
  });
});

describe("parseTimecodeToSec & formatSecToTimecode", () => {
  it("parses and formats millisecond and second timecodes accurately", () => {
    expect(parseTimecodeToSec("04:15.000")).toBe(255);
    expect(parseTimecodeToSec("05:02.500")).toBe(302.5);
    expect(parseTimecodeToSec("14:00")).toBe(840);
    expect(parseTimecodeToSec("01:02:03.250")).toBe(3723.25);
    expect(parseTimecodeToSec("invalid")).toBeNull();

    expect(formatSecToTimecode(255, true)).toBe("04:15.000");
    expect(formatSecToTimecode(302.5, true)).toBe("05:02.500");
    expect(formatSecToTimecode(840, false)).toBe("14:00");
  });
});

