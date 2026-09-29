import { describe, expect, it } from "vitest";

import { TranscriptChunkSchema } from "@montaj/edg/schemas";

import { parseSrt, wordsFromCues, wordsFromSrt } from "./srt.js";

const HINDI = [
  "\uFEFF1",
  "00:00:00,000 --> 00:00:02,000",
  "नमस्ते दोस्तों",
  "",
  "2",
  "00:00:02,500 --> 00:00:05,000",
  "<i>आज हम</i> बात करेंगे।",
  "",
].join("\r\n");

describe("parseSrt (2026-10-04)", () => {
  it("reads cues, markup and a BOM out, in time order", () => {
    expect(parseSrt(HINDI)).toEqual([
      { startMs: 0, endMs: 2_000, text: "नमस्ते दोस्तों" },
      { startMs: 2_500, endMs: 5_000, text: "आज हम बात करेंगे।" },
    ]);
  });

  it("takes a dot for the comma and a short fraction as a fraction of a second", () => {
    expect(parseSrt("1\n00:00:01.5 --> 00:00:02.25\nhi")).toEqual([
      { startMs: 1_500, endMs: 2_250, text: "hi" },
    ]);
  });

  it("skips what does not parse, and cues that end before they start", () => {
    const srt =
      "garbage\n\n1\n00:00:03,000 --> 00:00:02,000\nbackwards\n\n2\n00:00:04,000 --> 00:00:05,000\n{\\an8}ok";
    expect(parseSrt(srt)).toEqual([{ startMs: 4_000, endMs: 5_000, text: "ok" }]);
    expect(parseSrt("")).toEqual([]);
  });
});

describe("wordsFromCues", () => {
  it("spreads each cue's words over it by their length, and ids them in order", () => {
    const words = wordsFromCues([{ startMs: 1_000, endMs: 2_000, text: "a bbb" }], {
      durationMs: 10_000,
    });
    expect(words).toEqual([
      { wid: "0:0", s: 1_000, e: 1_250, t: "a" },
      { wid: "0:1", s: 1_250, e: 2_000, t: "bbb" },
    ]);
  });

  it("counts an Indic word by its letters, not its combining marks", () => {
    // कि (ka + i-matra) is one letter long to say; कक is two.
    const words = wordsFromCues([{ startMs: 0, endMs: 3_000, text: "कि कक" }], {
      durationMs: 10_000,
    });
    expect(words.map((word) => word.e - word.s)).toEqual([1_000, 2_000]);
  });

  it("keeps a mark that stands alone on the word before it", () => {
    const words = wordsFromCues([{ startMs: 0, endMs: 1_000, text: "बात करेंगे ।" }], {
      durationMs: 10_000,
    });
    expect(words.map((word) => word.t)).toEqual(["बात", "करेंगे ।"]);
  });

  it("drops what is past the picture and cuts what runs over its end", () => {
    const words = wordsFromCues(
      [
        { startMs: 0, endMs: 4_000, text: "one two" },
        { startMs: 5_000, endMs: 6_000, text: "gone" },
      ],
      { durationMs: 3_000 },
    );
    expect(words.map((word) => word.t)).toEqual(["one", "two"]);
    expect(Math.max(...words.map((word) => word.e))).toBe(3_000);
  });

  it("never lets time run back when cues overlap, and never makes a word of no length", () => {
    const words = wordsFromCues(
      [
        { startMs: 0, endMs: 2_000, text: "first line" },
        { startMs: 1_500, endMs: 1_600, text: "x y z" },
        { startMs: 1_900, endMs: 3_000, text: "after" },
      ],
      { durationMs: 10_000 },
    );
    for (const [index, word] of words.entries()) {
      expect(word.e).toBeGreaterThan(word.s);
      if (index > 0) expect(word.s).toBeGreaterThanOrEqual(words[index - 1]?.e ?? 0);
    }
    expect(words.map((word) => word.t)).toEqual(["first", "line", "after"]);
  });

  it("makes a chunk the transcript schema takes", () => {
    const words = wordsFromSrt(HINDI, { durationMs: 5_000 });
    expect(words).toHaveLength(6);
    expect(() =>
      TranscriptChunkSchema.parse({ chunkIdx: 0, startMs: 0, endMs: 5_000, words }),
    ).not.toThrow();
  });
});
