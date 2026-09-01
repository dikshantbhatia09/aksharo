import { describe, expect, it } from "vitest";

import type { WordId } from "@montaj/edg";

import { cutEdit } from "./edits.js";
import { buildTimeMap } from "./timemap.js";

import type { WordTimes } from "./segments.js";

/** 10 s of source, one cut removing 2–3 s. */
const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [cutEdit(2000, 3000)] });

const word = (n: number, s: number, e: number, deleted?: boolean): WordTimes => ({
  wid: `0:${n}` as WordId,
  s,
  e,
  ...(deleted === undefined ? {} : { deleted }),
});

describe("mapWord", () => {
  it("maps a word that survives whole", () => {
    expect(map.mapWord(word(0, 100, 400))).toEqual({
      wid: "0:0",
      hidden: false,
      ranges: [{ sourceStart: 100, sourceEnd: 400, outputStart: 100, outputEnd: 400 }],
    });
  });

  it("hides a word entirely inside a cut", () => {
    expect(map.mapWord(word(1, 2200, 2800))).toEqual({ wid: "0:1", hidden: true, ranges: [] });
    expect(map.mapWord(word(2, 2000, 3000)).hidden).toBe(true);
  });

  it("clips a word that overlaps a cut", () => {
    expect(map.mapWord(word(3, 1800, 2400)).ranges).toEqual([
      { sourceStart: 1800, sourceEnd: 2000, outputStart: 1800, outputEnd: 2000 },
    ]);
    expect(map.mapWord(word(4, 2800, 3200)).ranges).toEqual([
      { sourceStart: 3000, sourceEnd: 3200, outputStart: 2000, outputEnd: 2200 },
    ]);
  });

  it("splits a word that straddles a cut", () => {
    expect(map.mapWord(word(5, 1900, 3100)).ranges).toHaveLength(2);
  });

  it("treats a zero-length word as an instant", () => {
    expect(map.mapWord(word(6, 500, 500))).toEqual({
      wid: "0:6",
      hidden: false,
      ranges: [{ sourceStart: 500, sourceEnd: 500, outputStart: 500, outputEnd: 500 }],
    });
    expect(map.mapWord(word(7, 2500, 2500)).hidden).toBe(true);
    // The splice itself is not inside the cut, so an instant there survives.
    expect(map.mapWord(word(8, 2000, 2000)).hidden).toBe(false);
    expect(map.mapWord(word(9, 400, 100)).hidden).toBe(false);
  });
});

describe("mapSegment", () => {
  it("remaps a segment clear of every cut", () => {
    const mapped = map.mapSegment({ startMs: 4000, endMs: 5000 });
    expect(mapped).toMatchObject({
      hidden: false,
      outputStartMs: 3000,
      outputEndMs: 4000,
      hiddenWords: [],
      words: [],
    });
    expect(mapped.visibleRanges).toEqual([
      { sourceStart: 4000, sourceEnd: 5000, outputStart: 3000, outputEnd: 4000 },
    ]);
  });

  it("hides a segment that falls entirely inside a cut", () => {
    const mapped = map.mapSegment({ startMs: 2100, endMs: 2900 }, [word(0, 2100, 2900)]);
    expect(mapped.hidden).toBe(true);
    expect(mapped.visibleRanges).toEqual([]);
    expect(mapped.outputStartMs).toBeNull();
    expect(mapped.outputEndMs).toBeNull();
    expect(mapped.hiddenWords).toEqual(["0:0"]);
  });

  it("clips a segment that partially overlaps a cut", () => {
    const mapped = map.mapSegment({ startMs: 1500, endMs: 3500 }, [
      word(0, 1500, 1900),
      word(1, 2100, 2400),
      word(2, 3100, 3500),
    ]);
    expect(mapped.hidden).toBe(false);
    expect(mapped.visibleRanges).toEqual([
      { sourceStart: 1500, sourceEnd: 2000, outputStart: 1500, outputEnd: 2000 },
      { sourceStart: 3000, sourceEnd: 3500, outputStart: 2000, outputEnd: 2500 },
    ]);
    expect(mapped.outputStartMs).toBe(1500);
    expect(mapped.outputEndMs).toBe(2500);
    expect(mapped.hiddenWords).toEqual(["0:1"]);
    expect(mapped.words.map((each) => each.hidden)).toEqual([false, true, false]);
  });

  it("hides a segment whose live words all fell inside cuts, even when its span survived", () => {
    const mapped = map.mapSegment({ startMs: 1900, endMs: 3100 }, [word(0, 2100, 2900)]);
    expect(mapped.hidden).toBe(true);
    expect(mapped.visibleRanges).toEqual([]);
  });

  it("ignores tombstoned words", () => {
    const mapped = map.mapSegment({ startMs: 1900, endMs: 3100 }, [
      word(0, 2100, 2900, true),
      word(1, 3000, 3100),
    ]);
    expect(mapped.hidden).toBe(false);
    expect(mapped.hiddenWords).toEqual([]);
    expect(mapped.words).toHaveLength(1);
  });

  it("stays hidden when the author hid it", () => {
    const mapped = map.mapSegment({ startMs: 4000, endMs: 5000, hidden: true });
    expect(mapped.hidden).toBe(true);
    expect(mapped.visibleRanges).toEqual([]);
  });

  it("hides a segment with no live word left even when a deleted word survives", () => {
    const mapped = map.mapSegment({ startMs: 1900, endMs: 3100 }, [
      word(0, 2100, 2200),
      word(1, 2300, 2400),
    ]);
    expect(mapped.hidden).toBe(true);
    expect(mapped.hiddenWords).toEqual(["0:0", "0:1"]);
  });
});
