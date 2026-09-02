import { describe, expect, it } from "vitest";

import type { EdgOp, EdgState, Segment, Word } from "@montaj/edg";

import {
  computeInverseOps,
  currentOverridesAt,
  deleteWord,
  editWord,
  hideSegment,
  insertWordAfter,
  mergeSegments,
  mergeStyleOverrides,
  nextWordIdInChunk,
  panelOpToEdgOp,
  setEmphasis,
  setSegmentText,
  setWordTiming,
  splitSegment,
  type InverseState,
  type PanelOp,
} from "./ops";

let counter = 0;
function id(): string {
  counter += 1;
  return `id-${String(counter)}`;
}

function word(overrides: Partial<Word> & { wid: string }): Word {
  return { s: 0, e: 100, t: "hello", ...overrides };
}

function segment(overrides: Partial<Segment> & { id: string }): Segment {
  return {
    seq: "V",
    startWordId: "0:0" as never,
    endWordId: "0:0" as never,
    startMs: 0,
    endMs: 1000,
    ...overrides,
  };
}

describe("op builders", () => {
  it("build every op with a fresh opId", () => {
    expect(editWord("0:0", "hi", undefined, id)).toMatchObject({
      type: "EditWord",
      wordId: "0:0",
      text: "hi",
    });
    expect(deleteWord("0:0", id)).toMatchObject({ type: "DeleteWord", wordId: "0:0" });
    expect(insertWordAfter("0:0", "0:1", "hi", 0, 100, id)).toMatchObject({
      type: "InsertWordAfter",
      wordId: "0:0",
      newWordId: "0:1",
    });
    expect(splitSegment("s1", "0:1", "s2", id)).toMatchObject({
      type: "SplitSegment",
      segmentId: "s1",
      atWordId: "0:1",
    });
    expect(mergeSegments(["s1", "s2"], "s1", id)).toMatchObject({
      type: "MergeSegments",
      segmentIds: ["s1", "s2"],
    });
    expect(hideSegment("s1", true, id)).toMatchObject({ type: "HideSegment", hidden: true });
    expect(setSegmentText("s1", "roman", "hi", id)).toMatchObject({
      type: "SetSegmentText",
      script: "roman",
    });
    expect(setWordTiming("0:0", 100, 400, id)).toMatchObject({
      type: "SetWordTiming",
      wordId: "0:0",
      s: 100,
      e: 400,
    });
    expect(setEmphasis("s1", "0:0", "pop", id)).toMatchObject({
      type: "SetEmphasis",
      presetId: "pop",
    });
  });

  it("mints a distinct opId per call", () => {
    const a = editWord("0:0", "a", undefined, id);
    const b = editWord("0:0", "b", undefined, id);
    expect(a.opId).not.toBe(b.opId);
  });
});

describe("nextWordIdInChunk", () => {
  it("returns one past the highest n in the anchor's chunk", () => {
    const words = new Map([
      ["0:0", word({ wid: "0:0" })],
      ["0:3", word({ wid: "0:3" })],
      ["1:9", word({ wid: "1:9" })],
    ]);
    expect(nextWordIdInChunk(words, "0:0")).toBe("0:4");
  });

  it("ignores other chunks", () => {
    const words = new Map([
      ["0:0", word({ wid: "0:0" })],
      ["7:99", word({ wid: "7:99" })],
    ]);
    expect(nextWordIdInChunk(words, "0:0")).toBe("0:1");
  });
});

describe("panel op adaptation", () => {
  it("adapts SetStyle, merging the incoming partial onto the current overrides", () => {
    const state: Pick<EdgState, "hot" | "segments"> = {
      hot: {
        meta: { edgId: "e", projectId: "p", revision: 1, schemaVersion: 2 },
        media: [],
        transcript: { transcriptId: "t", revision: 1, language: "en", scripts: ["roman"] },
        canvas: { aspect: "9:16", width: 1080, height: 1920 },
        styles: { defaultStyleId: "punch-pop", inline: { doc: { typography: { sizePct: 8 } } } },
      },
      segments: new Map(),
    };
    const panelOp: PanelOp = {
      op: "SetStyle",
      opId: "p1",
      scope: "doc",
      overrides: { typography: { lineHeight: 1.2 } },
    };
    const edgOp = panelOpToEdgOp(panelOp, state);
    expect(edgOp).toEqual({
      type: "SetStyle",
      opId: "p1",
      scope: "doc",
      overrides: { typography: { sizePct: 8, lineHeight: 1.2 } },
    });
  });

  it("adapts SetSegmentPosition and SetEmphasis by field renaming", () => {
    const state: Pick<EdgState, "hot" | "segments"> = {
      hot: {} as never,
      segments: new Map(),
    };
    expect(
      panelOpToEdgOp(
        {
          op: "SetSegmentPosition",
          opId: "p2",
          segmentId: "s1",
          position: { x: 0.5, y: 0.9, anchor: "bottom-center" },
        },
        state,
      ),
    ).toEqual({
      type: "SetSegmentPosition",
      opId: "p2",
      segmentId: "s1",
      position: { x: 0.5, y: 0.9, anchor: "bottom-center" },
    });

    expect(
      panelOpToEdgOp(
        { op: "SetEmphasis", opId: "p3", segmentId: "s1", wordId: "0:0", presetId: "pop" },
        state,
      ),
    ).toEqual({
      type: "SetEmphasis",
      opId: "p3",
      segmentId: "s1",
      wordId: "0:0",
      presetId: "pop",
    });
  });

  it("currentOverridesAt reads the doc or segment scope", () => {
    const hot = { styles: { inline: { doc: { a: 1 } } } } as unknown as EdgState["hot"];
    const segments = new Map([["s1", segment({ id: "s1", overrides: { b: 2 } })]]);
    expect(currentOverridesAt(hot, segments, "doc", undefined)).toEqual({ a: 1 });
    expect(currentOverridesAt(hot, segments, "segment", "s1")).toEqual({ b: 2 });
    expect(currentOverridesAt(hot, segments, "segment", "missing")).toBeUndefined();
  });

  it("mergeStyleOverrides merges nested objects, incoming winning at each leaf", () => {
    expect(mergeStyleOverrides({ a: { x: 1, y: 2 } }, { a: { y: 3 } })).toEqual({
      a: { x: 1, y: 3 },
    });
    expect(mergeStyleOverrides(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(mergeStyleOverrides({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("computeInverseOps", () => {
  function state(overrides: Partial<InverseState> = {}): InverseState {
    return {
      hot: {
        meta: { edgId: "e", projectId: "p", revision: 1, schemaVersion: 2 },
        media: [],
        transcript: { transcriptId: "t", revision: 1, language: "en", scripts: ["roman"] },
        canvas: { aspect: "9:16", width: 1080, height: 1920 },
        styles: { defaultStyleId: "punch-pop" },
      } as never,
      segments: new Map(),
      words: new Map(),
      ...overrides,
    };
  }

  it("EditWord inverts to the prior text", () => {
    const s = state({ words: new Map([["0:0", word({ wid: "0:0", t: "helo" })]]) });
    const op: EdgOp = editWord("0:0", "hello", undefined, id);
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({ type: "EditWord", wordId: "0:0", text: "helo" });
  });

  it("EditWord on a script inverts to that script's prior text", () => {
    const s = state({
      words: new Map([["0:0", word({ wid: "0:0", t: "namaste", scripts: { roman: "namaste" } })]]),
    });
    const op: EdgOp = editWord("0:0", "namastey", "roman", id);
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({ type: "EditWord", script: "roman", text: "namaste" });
  });

  it("DeleteWord inverts to InsertWordAfter the previous live word, under a fresh id", () => {
    const s = state({
      words: new Map([
        ["0:0", word({ wid: "0:0", t: "one" })],
        ["0:1", word({ wid: "0:1", t: "two", s: 100, e: 200 })],
      ]),
    });
    const op: EdgOp = deleteWord("0:1", id);
    const [inverse] = computeInverseOps(op, s, id, () => "fresh-word");
    expect(inverse).toMatchObject({
      type: "InsertWordAfter",
      wordId: "0:0",
      newWordId: "fresh-word",
      text: "two",
    });
  });

  it("DeleteWord on the first word has no inverse (no anchor to insert after)", () => {
    const s = state({ words: new Map([["0:0", word({ wid: "0:0" })]]) });
    const op: EdgOp = deleteWord("0:0", id);
    expect(computeInverseOps(op, s, id, id)).toEqual([]);
  });

  it("SetWordTiming inverts to the word's prior timing", () => {
    const s = state({ words: new Map([["0:0", word({ wid: "0:0", s: 500, e: 950 })]]) });
    const op: EdgOp = setWordTiming("0:0", 460, 940, id);
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({ type: "SetWordTiming", wordId: "0:0", s: 500, e: 950 });
  });

  it("SetWordTiming on an unknown word has no inverse", () => {
    const op: EdgOp = setWordTiming("0:9", 0, 100, id);
    expect(computeInverseOps(op, state(), id, id)).toEqual([]);
  });

  it("InsertWordAfter inverts to DeleteWord of the new id", () => {
    const op: EdgOp = insertWordAfter("0:0", "0:1", "hi", 0, 100, id);
    const [inverse] = computeInverseOps(op, state(), id, id);
    expect(inverse).toBeDefined();
    expect(inverse).toEqual(deleteWord("0:1", () => inverse!.opId));
  });

  it("SplitSegment inverts to MergeSegments of the two halves", () => {
    const op: EdgOp = splitSegment("s1", "0:1", "s2", id);
    const [inverse] = computeInverseOps(op, state(), id, id);
    expect(inverse).toMatchObject({
      type: "MergeSegments",
      segmentIds: ["s1", "s2"],
      newSegmentId: "s1",
    });
  });

  it("MergeSegments of exactly two segments inverts to a split plus the second's discarded style/position", () => {
    const s = state({
      segments: new Map([
        [
          "s2",
          segment({
            id: "s2",
            startWordId: "0:5" as never,
            styleRef: "bold-drop",
            position: { x: 0.1, y: 0.2, anchor: "top-left" },
          }),
        ],
      ]),
    });
    const op: EdgOp = mergeSegments(["s1", "s2"], "s1", id);
    const ops = computeInverseOps(op, s, id, id);
    expect(ops[0]).toMatchObject({ type: "SplitSegment", segmentId: "s1", atWordId: "0:5" });
    expect(
      ops.some(
        (entry) =>
          entry.type === "SetStyle" && "styleRef" in entry && entry.styleRef === "bold-drop",
      ),
    ).toBe(true);
    expect(ops.some((entry) => entry.type === "SetSegmentPosition")).toBe(true);
  });

  it("MergeSegments of more than two is not inverted (bulk merges are out of scope for undo)", () => {
    const op: EdgOp = mergeSegments(["s1", "s2", "s3"], "s1", id);
    expect(computeInverseOps(op, state(), id, id)).toEqual([]);
  });

  it("HideSegment inverts to the prior hidden flag", () => {
    const s = state({ segments: new Map([["s1", segment({ id: "s1", hidden: false })]]) });
    const op: EdgOp = hideSegment("s1", true, id);
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({ type: "HideSegment", segmentId: "s1", hidden: false });
  });

  it("SetEmphasis inverts to the prior preset, including clearing to null", () => {
    const s = state({
      segments: new Map([
        ["s1", segment({ id: "s1", emphasis: [{ wordId: "0:0", presetId: "pop" }] })],
      ]),
    });
    const op: EdgOp = setEmphasis("s1", "0:0", "shake", id);
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({ type: "SetEmphasis", presetId: "pop" });

    const clearOp: EdgOp = setEmphasis("s1", "0:1", "pop", id);
    const [clearInverse] = computeInverseOps(clearOp, s, id, id);
    expect(clearInverse).toMatchObject({ type: "SetEmphasis", presetId: null });
  });

  it("SetSegmentPosition inverts to the prior position, or null", () => {
    const s = state({ segments: new Map([["s1", segment({ id: "s1" })]]) });
    const op: EdgOp = {
      type: "SetSegmentPosition",
      opId: id(),
      segmentId: "s1",
      position: { x: 0.5, y: 0.5, anchor: "center" },
    };
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({ type: "SetSegmentPosition", position: null });
  });

  it("SetStyle at segment scope inverts to the segment's prior style/overrides", () => {
    const s = state({
      segments: new Map([
        ["s1", segment({ id: "s1", styleRef: "old-style", overrides: { a: 1 } })],
      ]),
    });
    const op: EdgOp = {
      type: "SetStyle",
      opId: id(),
      scope: "segment",
      segmentId: "s1",
      styleRef: "new-style",
    };
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({
      type: "SetStyle",
      scope: "segment",
      segmentId: "s1",
      styleRef: "old-style",
      overrides: { a: 1 },
    });
  });

  it("SetStyle at doc scope inverts to the document's prior default/overrides", () => {
    const s = state();
    const op: EdgOp = { type: "SetStyle", opId: id(), scope: "doc", styleRef: "new-default" };
    const [inverse] = computeInverseOps(op, s, id, id);
    expect(inverse).toMatchObject({
      type: "SetStyle",
      scope: "doc",
      styleRef: "punch-pop",
      overrides: {},
    });
  });

  it("returns [] for ops the editor never emits (Resegment, SetAudio, ...)", () => {
    const op: EdgOp = {
      type: "Resegment",
      opId: id(),
      maxChars: 32,
      maxLines: 2,
      minMs: 800,
      maxMs: 4500,
    };
    expect(computeInverseOps(op, state(), id, id)).toEqual([]);
  });

  it("returns [] when the op names an id the state does not have", () => {
    expect(computeInverseOps(editWord("0:99", "x", undefined, id), state(), id, id)).toEqual([]);
    expect(computeInverseOps(hideSegment("missing", true, id), state(), id, id)).toMatchObject([
      { type: "HideSegment", segmentId: "missing", hidden: false },
    ]);
  });
});
