import { describe, expect, it } from "vitest";

import { EMPTY_LOUDNESS, parseLoudness, parseSilences } from "./loudness.js";

/** A real ffmpeg 9 report, trimmed to the lines that matter. */
const REPORT = `
[silencedetect @ 000001f0] silence_start: 0
[silencedetect @ 000001f0] silence_end: 1.2 | silence_duration: 1.2
[silencedetect @ 000001f0] silence_start: 6.5
[silencedetect @ 000001f0] silence_end: 8.1 | silence_duration: 1.6
[Parsed_ebur128_0 @ 000002a0] Summary:

  Integrated loudness:
    I:         -18.4 LUFS
    Threshold: -28.6 LUFS

  Loudness range:
    LRA:         6.2 LU
    Threshold: -38.6 LUFS
    LRA low:   -21.4 LUFS
    LRA high:  -15.2 LUFS

  True peak:
    Peak:       -1.5 dBFS
`;

describe("parseSilences", () => {
  it("pairs starts with ends", () => {
    expect(parseSilences(REPORT)).toEqual([
      { startMs: 0, endMs: 1_200 },
      { startMs: 6_500, endMs: 8_100 },
    ]);
  });

  it("drops a start with no end — a file that finished silent", () => {
    // Zipping the two lists by index instead of matching them in order would leave
    // an unbalanced pair here and shift every span after it.
    const trailing = `${REPORT}[silencedetect @ x] silence_start: 9.5\n`;
    expect(parseSilences(trailing)).toHaveLength(2);
  });

  it("finds nothing in a report with no silence in it", () => {
    expect(parseSilences("[Parsed_ebur128_0] Summary:\n  I: -14.0 LUFS\n")).toEqual([]);
  });
});

describe("parseLoudness", () => {
  it("reads the three EBU R128 figures by label", () => {
    const report = parseLoudness(REPORT, 10_000);
    expect(report.loudnessLufs).toBe(-18.4);
    expect(report.loudnessRangeLu).toBe(6.2);
    expect(report.truePeakDbfs).toBe(-1.5);
  });

  it("computes the silent fraction of the timeline", () => {
    // 1.2 s + 1.6 s of 10 s.
    expect(parseLoudness(REPORT, 10_000).silenceRatio).toBeCloseTo(0.28, 3);
  });

  it("never reports a ratio above one, whatever the spans say", () => {
    const overlong = "silence_start: 0\nsilence_end: 30\n";
    expect(parseLoudness(overlong, 10_000).silenceRatio).toBe(1);
  });

  it("leaves the ratio unknown when the duration is unknown", () => {
    expect(parseLoudness(REPORT, 0).silenceRatio).toBeNull();
  });

  it("treats a silent track's `-inf` peak as unknown rather than as a number", () => {
    // `-inf dBFS` is true and is not something a JSON column can hold.
    const silent = "  True peak:\n    Peak:       -inf dBFS\n";
    expect(parseLoudness(silent, 1_000).truePeakDbfs).toBeNull();
  });

  it("answers nulls for a report it did not recognise at all", () => {
    const empty = parseLoudness("ffmpeg said nothing useful", 1_000);
    expect(empty.loudnessLufs).toBeNull();
    expect(empty.loudnessRangeLu).toBeNull();
    expect(empty.silences).toEqual([]);
  });

  it("returns the longest spans, in timeline order", () => {
    const many = Array.from({ length: 80 }, (_unused, index) => {
      const start = index * 10;
      // Later spans are longer, so the cap has something to choose between.
      return `silence_start: ${String(start)}\nsilence_end: ${String(start + index / 10 + 0.5)}\n`;
    }).join("");
    const report = parseLoudness(many, 1_000_000);
    expect(report.silences.length).toBeLessThanOrEqual(50);
    const starts = report.silences.map((span) => span.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe("EMPTY_LOUDNESS", () => {
  it("is what a skipped or failed pass reports — nulls, never zeros", () => {
    // Zero LUFS is deafening; "we did not measure" has to be distinguishable.
    expect(EMPTY_LOUDNESS.loudnessLufs).toBeNull();
    expect(EMPTY_LOUDNESS.silenceRatio).toBeNull();
    expect(EMPTY_LOUDNESS.silences).toEqual([]);
  });
});
