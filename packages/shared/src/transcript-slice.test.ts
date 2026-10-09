import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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
    assert.equal(sliced.length, 5);
    assert.deepEqual(
      sliced.map((w) => w.id),
      ["w2", "w3", "w4", "w5", "w6"],
    );
    assert.equal(Number(sliced[0]!.clipRelativeStart.toFixed(3)), 0);
    assert.equal(Number(sliced[0]!.clipRelativeEnd.toFixed(3)), 0.25);
    assert.equal(Number(sliced[4]!.clipRelativeStart.toFixed(3)), 2.9);
    assert.equal(Number(sliced[4]!.clipRelativeEnd.toFixed(3)), 3.2);
  });

  it("clamps negative relative start offsets to 0 when a word spans across startSec", () => {
    // Word w1 starts at 10.0 and ends at 10.4; clip starts at 10.2
    const sliced = sliceTranscriptWords(SAMPLE_WORDS, 10.2, 11.0);
    assert.equal(sliced.length, 3);
    assert.equal(sliced[0]!.id, "w1");
    assert.equal(sliced[0]!.clipRelativeStart, 0);
    assert.equal(Number(sliced[0]!.clipRelativeEnd.toFixed(3)), 0.2);
  });

  it("includes words spanning across endSec", () => {
    // Word w4 starts at 11.15 and ends at 11.8; clip ends at 11.3
    const sliced = sliceTranscriptWords(SAMPLE_WORDS, 10.8, 11.3);
    assert.deepEqual(
      sliced.map((w) => w.id),
      ["w3", "w4"],
    );
    assert.equal(Number(sliced[1]!.clipRelativeStart.toFixed(3)), 0.35);
    assert.equal(Number(sliced[1]!.clipRelativeEnd.toFixed(3)), 1.0);
  });

  it("returns empty array for inverted or non-finite bounds", () => {
    assert.deepEqual(sliceTranscriptWords(SAMPLE_WORDS, 15, 10), []);
    assert.deepEqual(sliceTranscriptWords(SAMPLE_WORDS, Number.NaN, 12), []);
    assert.deepEqual(sliceTranscriptWords([], 0, 10), []);
  });
});

describe("sliceTranscriptLines", () => {
  it("groups sliced words into subtitle lines with pause and sentence breaks", () => {
    const lines = sliceTranscriptLines(SAMPLE_WORDS, 10.0, 14.5);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.text, "Wait for this punchline.");
    assert.equal(lines[0]!.clipRelativeStartSec, 0);
    assert.equal(Number(lines[0]!.clipRelativeEndSec.toFixed(2)), 1.8);
    assert.equal(lines[1]!.text, "Nobody saw it coming!");
    assert.equal(Number(lines[1]!.clipRelativeStartSec.toFixed(2)), 2.8);
    assert.equal(Number(lines[1]!.clipRelativeEndSec.toFixed(2)), 4.5);
  });
});

describe("snapToWordBoundary & quantizeToFrame", () => {
  it("magnetically snaps to the nearest word start or end within ±0.2s", () => {
    // w2 starts at 10.45; requesting 10.58 is 0.13s away (<= 0.2s)
    const startSnap = snapToWordBoundary(10.58, SAMPLE_WORDS, "start");
    assert.equal(startSnap.snapped, true);
    assert.equal(startSnap.timeSec, 10.45);
    assert.equal(startSnap.snappedWordId, "w2");

    // w4 ends at 11.80; requesting 11.95 is 0.15s away (<= 0.2s)
    const endSnap = snapToWordBoundary(11.95, SAMPLE_WORDS, "end");
    assert.equal(endSnap.snapped, true);
    assert.equal(endSnap.timeSec, 11.8);
    assert.equal(endSnap.snappedWordId, "w4");
    assert.equal(endSnap.snappedSentenceBoundary, true);
  });

  it("does not snap when distance exceeds ±0.2s tolerance", () => {
    // 12.3s is in the middle of the pause between 11.8s and 12.8s
    const unsnapped = snapToWordBoundary(12.3, SAMPLE_WORDS, "start");
    assert.equal(unsnapped.snapped, false);
    assert.equal(unsnapped.snappedWordId, null);
    assert.equal(unsnapped.timeSec, quantizeToFrame(12.3, 30));
  });

  it("bypasses magnetic snapping on Shift-drag and quantizes to 1/30s frame precision", () => {
    // 10.46s is 0.01s from w2.start (10.45s), but bypassSnap=true forces 1/30s frame quantization
    const bypassed = snapToWordBoundary(10.46, SAMPLE_WORDS, "start", {
      bypassSnap: true,
      fps: 30,
    });
    assert.equal(bypassed.snapped, false);
    assert.equal(bypassed.snappedWordId, null);
    // 10.46 * 30 = 313.8 -> 314 / 30 = 10.466667
    assert.equal(bypassed.timeSec, Number((314 / 30).toFixed(6)));
  });
});

describe("parseTimecodeToSec & formatSecToTimecode", () => {
  it("parses and formats millisecond and second timecodes accurately", () => {
    assert.equal(parseTimecodeToSec("04:15.000"), 255);
    assert.equal(parseTimecodeToSec("05:02.500"), 302.5);
    assert.equal(parseTimecodeToSec("14:00"), 840);
    assert.equal(parseTimecodeToSec("01:02:03.250"), 3723.25);
    assert.equal(parseTimecodeToSec("invalid"), null);

    assert.equal(formatSecToTimecode(255, true), "04:15.000");
    assert.equal(formatSecToTimecode(302.5, true), "05:02.500");
    assert.equal(formatSecToTimecode(840, false), "14:00");
  });
});

