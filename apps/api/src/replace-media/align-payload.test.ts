import { describe, expect, it } from "vitest";

import type { Segment, Word } from "@montaj/edg/schemas";

import { buildAlignPayload } from "./align-payload.js";

function segment(overrides: Partial<Segment> = {}): Segment {
  return {
    id: "01JSEGMENT00000000000000A",
    seq: "a0",
    startWordId: "0:0",
    endWordId: "0:2",
    startMs: 0,
    endMs: 1500,
    ...overrides,
  } as Segment;
}

function word(overrides: Partial<Word> = {}): Word {
  return { wid: "0:0", s: 0, e: 400, t: "hello", ...overrides } as Word;
}

describe("buildAlignPayload", () => {
  it("turns one segment's live words into one {startMs, endMs, text}", () => {
    const words = [
      word({ wid: "0:0", s: 0, e: 400, t: "namaste" }),
      word({ wid: "0:1", s: 400, e: 800, t: "dosto" }),
      word({ wid: "0:2", s: 800, e: 1200, t: "aaj" }),
    ];
    const segments = [segment()];

    const result = buildAlignPayload(segments, words);

    expect(result.segments).toEqual([{ startMs: 0, endMs: 1500, text: "namaste dosto aaj" }]);
    expect(result.segmentWordIds).toEqual([
      { segmentId: "01JSEGMENT00000000000000A", wordIds: ["0:0", "0:1", "0:2"] },
    ]);
  });

  it("skips hidden segments", () => {
    const words = [word()];
    const segments = [segment({ hidden: true, startWordId: "0:0", endWordId: "0:0" })];

    const result = buildAlignPayload(segments, words);

    expect(result.segments).toEqual([]);
    expect(result.segmentWordIds).toEqual([]);
  });

  it("excludes deleted words from the text and the word-id list", () => {
    const words = [
      word({ wid: "0:0", s: 0, e: 400, t: "namaste" }),
      word({ wid: "0:1", s: 400, e: 800, t: "matlab", deleted: true }),
      word({ wid: "0:2", s: 800, e: 1200, t: "aaj" }),
    ];
    const segments = [segment()];

    const result = buildAlignPayload(segments, words);

    expect(result.segments[0]?.text).toBe("namaste aaj");
    expect(result.segmentWordIds[0]?.wordIds).toEqual(["0:0", "0:2"]);
  });

  it("drops a segment left with no live words", () => {
    const words = [word({ wid: "0:0", deleted: true })];
    const segments = [segment({ startWordId: "0:0", endWordId: "0:0" })];

    const result = buildAlignPayload(segments, words);

    expect(result.segments).toEqual([]);
  });

  it("applies the caller's segment filter (e.g. only segments touching one media item)", () => {
    const words = [word({ wid: "0:0" }), word({ wid: "1:0", s: 2000, e: 2400, t: "next" })];
    const segments = [
      segment({ id: "SEG1", startWordId: "0:0", endWordId: "0:0" }),
      segment({ id: "SEG2", startWordId: "1:0", endWordId: "1:0", startMs: 2000, endMs: 2400 }),
    ];

    const result = buildAlignPayload(segments, words, (segment) => segment.id === "SEG2");

    expect(result.segmentWordIds).toEqual([{ segmentId: "SEG2", wordIds: ["1:0"] }]);
  });
});
