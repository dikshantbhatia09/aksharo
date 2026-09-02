import { describe, expect, it } from "vitest";

import { type EdgOp } from "@montaj/edg/schemas";

import { analyseWorkingSet, chunkIndexOf, chunkWindow } from "./edg.working-set.js";

const SEG_A = "01JCSEG00000000000000000AA";
const SEG_B = "01JCSEG00000000000000000BB";
const SEG_C = "01JCSEG00000000000000000CC";
const OP = "01JCOP000000000000000000AA";

describe("analyseWorkingSet", () => {
  it("collects the segments an op names and leaves ids it will create alone", () => {
    const ops: EdgOp[] = [
      { opId: OP, type: "SplitSegment", segmentId: SEG_A, atWordId: "0:4", newSegmentId: SEG_B },
    ];

    const request = analyseWorkingSet(ops);

    expect(request.segmentIds).toEqual([SEG_A]);
    expect(request.wordIds).toEqual(["0:4"]);
    expect(request.wholeDocument).toBe(false);
    expect(request.touchesWords).toBe(false);
  });

  it("asks for every segment a merge names, so contiguity can be checked", () => {
    const request = analyseWorkingSet([
      { opId: OP, type: "MergeSegments", segmentIds: [SEG_A, SEG_C], newSegmentId: SEG_B },
    ]);

    expect(request.segmentIds).toEqual([SEG_A, SEG_C]);
  });

  it("marks a word delete so the segments it bounds are found by word id", () => {
    const request = analyseWorkingSet([{ opId: OP, type: "DeleteWord", wordId: "2:17" }]);

    expect(request.boundaryWordIds).toEqual(["2:17"]);
    expect(request.touchesWords).toBe(true);
  });

  it("does not treat an emphasis change as a transcript write", () => {
    const request = analyseWorkingSet([
      { opId: OP, type: "SetEmphasis", segmentId: SEG_A, wordId: "0:2", presetId: "pop" },
    ]);

    expect(request.wordIds).toEqual(["0:2"]);
    expect(request.touchesWords).toBe(false);
  });

  it("gives up on a bounded read for a Resegment", () => {
    const request = analyseWorkingSet([
      { opId: OP, type: "Resegment", maxChars: 32, maxLines: 2, minMs: 700, maxMs: 6000 },
    ]);

    expect(request.wholeDocument).toBe(true);
    // A resegment re-reads every live word, so the transcript is part of the load.
    expect(request.touchesWords).toBe(true);
  });

  it("collects both anchors of an insert, so the new id can be range-checked", () => {
    const request = analyseWorkingSet([
      {
        opId: OP,
        type: "InsertWordAfter",
        wordId: "1:9",
        newWordId: "1:400",
        text: "अच्छा",
        s: 10,
        e: 20,
      },
    ]);

    expect(request.wordIds).toEqual(["1:9", "1:400"]);
  });

  it("marks a word retime as a transcript write and asks for the word's own segment", () => {
    const request = analyseWorkingSet([
      { opId: OP, type: "SetWordTiming", wordId: "0:5", s: 2_000, e: 2_400 },
    ]);

    expect(request.wordIds).toEqual(["0:5"]);
    expect(request.timingWordIds).toEqual(["0:5"]);
    expect(request.boundaryWordIds).toEqual([]);
    expect(request.touchesWords).toBe(true);
    expect(request.needsWords).toBe(true);
  });

  it("carries item and pass ids for the review ops", () => {
    const itemId = "01JCITEM0000000000000000AA";
    const passId = "01JCPASS0000000000000000AA";
    const request = analyseWorkingSet([
      { opId: OP, type: "DecideItems", itemIds: [itemId], state: "accepted" },
    ]);

    expect(request.itemIds).toEqual([itemId]);
    expect(analyseWorkingSet([]).passIds).toEqual([]);
    expect(passId).toHaveLength(26);
  });

  it("asks for nothing at all for a document-level op", () => {
    const request = analyseWorkingSet([{ opId: OP, type: "SetRender", presets: ["reels-1080"] }]);

    expect(request).toMatchObject({
      wholeDocument: false,
      segmentIds: [],
      wordIds: [],
      itemIds: [],
      touchesWords: false,
    });
  });

  it("deduplicates ids across a batch", () => {
    const request = analyseWorkingSet([
      { opId: OP, type: "HideSegment", segmentId: SEG_A, hidden: true },
      { opId: `${OP}B`, type: "SetSegmentText", segmentId: SEG_A, script: "roman", text: "hi" },
    ]);

    expect(request.segmentIds).toEqual([SEG_A]);
  });
});

describe("chunkWindow", () => {
  it("takes the chunk a word is in plus one either side", () => {
    expect(chunkWindow(["3:1"])).toEqual([2, 3, 4]);
  });

  it("never asks for a chunk index below zero", () => {
    expect(chunkWindow(["0:1"])).toEqual([0, 1]);
  });

  it("merges the windows of several words", () => {
    expect(chunkWindow(["0:1", "4:9"])).toEqual([0, 1, 3, 4, 5]);
  });

  it("ignores a malformed word id rather than throwing", () => {
    expect(chunkWindow(["not-a-word-id"])).toEqual([]);
    expect(chunkIndexOf("nope")).toBeUndefined();
    expect(chunkIndexOf("7:2")).toBe(7);
  });
});

describe("needsWords", () => {
  it("is false for the edits that never rank a word", () => {
    const ops: EdgOp[] = [
      { opId: OP, type: "SetSegmentText", segmentId: SEG_A, script: "roman", text: "arre" },
      { opId: `${OP}B`, type: "HideSegment", segmentId: SEG_A, hidden: true },
      { opId: `${OP}C`, type: "SetStyle", scope: "doc", styleRef: "punch-pop" },
      { opId: `${OP}D`, type: "SetSegmentPosition", segmentId: SEG_A, position: null },
    ];
    expect(analyseWorkingSet(ops).needsWords).toBe(false);
  });

  it("is true for everything that consults the transcript", () => {
    const cases: EdgOp[] = [
      { opId: OP, type: "SetEmphasis", segmentId: SEG_A, wordId: "0:1", presetId: "pop" },
      { opId: OP, type: "SetSegmentBounds", segmentId: SEG_A, startMs: 0, endMs: 10 },
      { opId: OP, type: "SplitSegment", segmentId: SEG_A, atWordId: "0:1", newSegmentId: SEG_B },
      { opId: OP, type: "MergeSegments", segmentIds: [SEG_A, SEG_B], newSegmentId: SEG_C },
      { opId: OP, type: "EditWord", wordId: "0:1", text: "arre" },
      { opId: OP, type: "DeleteWord", wordId: "0:1" },
      { opId: OP, type: "Resegment", maxChars: 32, maxLines: 2, minMs: 700, maxMs: 6000 },
    ];
    for (const op of cases) expect(analyseWorkingSet([op]).needsWords).toBe(true);
  });
});
