import { describe, expect, it } from "vitest";

import { type EdgOp, type OpRejectionReason } from "../schemas/ops.js";
import { type Pass } from "../schemas/pass.js";
import { buildFixture, idFactory } from "../testing.js";
import { validateProjection } from "../validate.js";
import { applyOps, DOC_STYLE_OVERRIDE_KEY, normaliseProtectedRanges } from "./apply.js";
import { fromProjection, toProjection, type EdgState } from "./state.js";

const nextOpId = idFactory(900_000);

function op<T extends EdgOp["type"]>(
  type: T,
  fields: Omit<Extract<EdgOp, { type: T }>, "type" | "opId">,
): EdgOp {
  return { opId: nextOpId(), type, ...fields } as EdgOp;
}

function setup(options: Parameters<typeof buildFixture>[0] = {}) {
  const fixture = buildFixture(options);
  const state = fromProjection(fixture.projection, { chunks: fixture.chunks });
  return { ...fixture, state };
}

/** Applies a batch and asserts the document is still well formed. */
function apply(state: EdgState, ops: EdgOp[], ctx: Parameters<typeof applyOps>[2] = {}) {
  const result = applyOps(state, ops, ctx);
  expect(validateProjection(toProjection(result.state), { wordIndex: result.state.words })).toEqual(
    [],
  );
  return result;
}

function reasons(result: { rejected: { reason: OpRejectionReason }[] }): OpRejectionReason[] {
  return result.rejected.map((rejection) => rejection.reason);
}

function segment(state: EdgState, id: string) {
  const found = state.segments.get(id);
  if (found === undefined) throw new Error(`segment ${id} is gone`);
  return found;
}

describe("SetSegmentText", () => {
  it("writes one script without touching the others", () => {
    const { state, segmentIds } = setup();
    const first = segmentIds[0] ?? "";
    const result = apply(state, [
      op("SetSegmentText", { segmentId: first, script: "en", text: "Brother, today" }),
      op("SetSegmentText", { segmentId: first, script: "native", text: "भाई आज" }),
    ]);
    expect(result.applied).toHaveLength(2);
    expect(segment(result.state, first).textOverrides).toEqual({
      en: "Brother, today",
      native: "भाई आज",
    });
  });

  it("rejects an unknown segment as unknown-id and a dead one as stale", () => {
    const { state, segmentIds } = setup();
    const merged = applyOps(state, [
      op("MergeSegments", {
        segmentIds: [segmentIds[0] ?? "", segmentIds[1] ?? ""],
        newSegmentId: idFactory(500)(),
      }),
    ]);
    const result = applyOps(merged.state, [
      op("SetSegmentText", { segmentId: idFactory(77)(), script: "en", text: "x" }),
      op("SetSegmentText", { segmentId: segmentIds[0] ?? "", script: "en", text: "x" }),
    ]);
    expect(reasons(result)).toEqual(["unknown-id", "stale"]);
  });
});

describe("SetSegmentBounds", () => {
  it("moves the boundary words and the times together", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const result = apply(state, [
      op("SetSegmentBounds", {
        segmentId: first,
        startMs: 500,
        endMs: 2450,
        startWordId: wordIds[1] ?? "0:1",
        endWordId: wordIds[4] ?? "0:4",
      }),
    ]);
    expect(segment(result.state, first)).toMatchObject({
      startWordId: "0:1",
      endWordId: "0:4",
      startMs: 500,
      endMs: 2450,
    });
  });

  it("drops emphasis the new range no longer covers", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const emphasised = apply(state, [
      op("SetEmphasis", { segmentId: first, wordId: wordIds[0] ?? "0:0", presetId: "pop" }),
      op("SetEmphasis", { segmentId: first, wordId: wordIds[3] ?? "0:3", presetId: "pop" }),
    ]);
    const result = apply(emphasised.state, [
      op("SetSegmentBounds", {
        segmentId: first,
        startMs: 1000,
        endMs: 1950,
        startWordId: wordIds[2] ?? "0:2",
      }),
    ]);
    expect(segment(result.state, first).emphasis).toEqual([{ wordId: "0:3", presetId: "pop" }]);
  });

  it("rejects backwards times, backwards words, unknown words and deleted words", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[1] ?? "0:1" })]);
    const result = applyOps(deleted.state, [
      op("SetSegmentBounds", { segmentId: first, startMs: 900, endMs: 100 }),
      op("SetSegmentBounds", {
        segmentId: first,
        startMs: 0,
        endMs: 1950,
        startWordId: wordIds[3] ?? "0:3",
        endWordId: wordIds[2] ?? "0:2",
      }),
      op("SetSegmentBounds", { segmentId: first, startMs: 0, endMs: 10, startWordId: "9:9" }),
      op("SetSegmentBounds", {
        segmentId: first,
        startMs: 0,
        endMs: 10,
        startWordId: wordIds[1] ?? "0:1",
      }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range", "invalid-range", "unknown-id", "stale"]);
  });
});

describe("SplitSegment", () => {
  it("splits before the word and orders the tail after the head", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const newSegmentId = idFactory(600)();
    const result = apply(state, [
      op("SetSegmentText", { segmentId: first, script: "en", text: "whole line" }),
      op("SplitSegment", { segmentId: first, atWordId: wordIds[2] ?? "0:2", newSegmentId }),
    ]);
    expect(result.state.segmentOrder.slice(0, 2)).toEqual([first, newSegmentId]);
    expect(segment(result.state, first)).toMatchObject({ endWordId: "0:1", endMs: 950 });
    expect(segment(result.state, newSegmentId)).toMatchObject({
      startWordId: "0:2",
      endWordId: "0:3",
      startMs: 1000,
      endMs: 1950,
    });
    // The override described the whole line, so only the head keeps it.
    expect(segment(result.state, first).textOverrides).toEqual({ en: "whole line" });
    expect(segment(result.state, newSegmentId).textOverrides).toBeUndefined();
  });

  it("rejects a split at the first word, outside the segment, or onto a used id", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const result = applyOps(state, [
      op("SplitSegment", {
        segmentId: first,
        atWordId: wordIds[0] ?? "0:0",
        newSegmentId: idFactory(601)(),
      }),
      op("SplitSegment", {
        segmentId: first,
        atWordId: wordIds[8] ?? "0:8",
        newSegmentId: idFactory(602)(),
      }),
      op("SplitSegment", {
        segmentId: first,
        atWordId: wordIds[2] ?? "0:2",
        newSegmentId: segmentIds[1] ?? "",
      }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range", "invalid-range", "invariant"]);
  });

  it("rejects a split whose head would hold no live word", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[0] ?? "0:0" })]);
    const result = applyOps(deleted.state, [
      op("SplitSegment", {
        segmentId: first,
        atWordId: wordIds[1] ?? "0:1",
        newSegmentId: idFactory(603)(),
      }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
  });
});

describe("MergeSegments", () => {
  it("keeps the first segment's style, spans both ranges and merges emphasis", () => {
    const { state, segmentIds, wordIds } = setup();
    const [first = "", second = ""] = segmentIds;
    const newSegmentId = idFactory(610)();
    const prepared = apply(state, [
      op("SetStyle", { scope: "segment", segmentId: first, styleRef: "punch-pop" }),
      op("SetStyle", { scope: "segment", segmentId: second, styleRef: "clean-caption" }),
      op("SetEmphasis", { segmentId: first, wordId: wordIds[1] ?? "0:1", presetId: "pop" }),
      op("SetEmphasis", { segmentId: second, wordId: wordIds[5] ?? "0:5", presetId: "shake" }),
      op("SetSegmentText", { segmentId: first, script: "en", text: "first half" }),
      op("SetSegmentText", { segmentId: second, script: "en", text: "second half" }),
    ]);
    const result = apply(prepared.state, [
      op("MergeSegments", { segmentIds: [second, first], newSegmentId }),
    ]);
    const merged = segment(result.state, newSegmentId);
    expect(merged).toMatchObject({
      seq: prepared.state.segments.get(first)?.seq,
      startWordId: "0:0",
      endWordId: "0:7",
      startMs: 0,
      endMs: 3950,
      styleRef: "punch-pop",
    });
    expect(merged.textOverrides).toEqual({ en: "first half second half" });
    expect(merged.emphasis).toEqual([
      { wordId: "0:1", presetId: "pop" },
      { wordId: "0:5", presetId: "shake" },
    ]);
    expect(result.state.tombstones.has(first)).toBe(true);
    expect(result.state.segmentOrder).toEqual([newSegmentId, segmentIds[2]]);
  });

  it("keeps a per-script override only when every segment had one", () => {
    const { state, segmentIds } = setup();
    const [first = "", second = ""] = segmentIds;
    const prepared = apply(state, [
      op("SetSegmentText", { segmentId: first, script: "en", text: "only here" }),
    ]);
    const result = apply(prepared.state, [
      op("MergeSegments", { segmentIds: [first, second], newSegmentId: idFactory(611)() }),
    ]);
    expect(segment(result.state, result.state.segmentOrder[0] ?? "").textOverrides).toBeUndefined();
  });

  it("rejects non-neighbours, repeated ids, used ids and unknown ids", () => {
    const { state, segmentIds } = setup();
    const [first = "", second = "", third = ""] = segmentIds;
    const result = applyOps(state, [
      op("MergeSegments", { segmentIds: [first, third], newSegmentId: idFactory(612)() }),
      op("MergeSegments", { segmentIds: [first, first], newSegmentId: idFactory(613)() }),
      op("MergeSegments", { segmentIds: [first, second], newSegmentId: first }),
      op("MergeSegments", { segmentIds: [first, idFactory(88)()], newSegmentId: idFactory(614)() }),
    ]);
    expect(reasons(result)).toEqual(["not-contiguous", "invalid", "invariant", "unknown-id"]);
  });
});

describe("SetEmphasis", () => {
  it("sets, replaces and clears one word", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const set = apply(state, [
      op("SetEmphasis", { segmentId: first, wordId: wordIds[2] ?? "0:2", presetId: "pop" }),
    ]);
    expect(segment(set.state, first).emphasis).toEqual([{ wordId: "0:2", presetId: "pop" }]);
    const replaced = apply(set.state, [
      op("SetEmphasis", { segmentId: first, wordId: wordIds[2] ?? "0:2", presetId: "shake" }),
    ]);
    expect(segment(replaced.state, first).emphasis).toEqual([{ wordId: "0:2", presetId: "shake" }]);
    const cleared = apply(replaced.state, [
      op("SetEmphasis", { segmentId: first, wordId: wordIds[2] ?? "0:2", presetId: null }),
    ]);
    expect(segment(cleared.state, first).emphasis).toBeUndefined();
  });

  it("rejects a word outside the segment and one that is not in the transcript", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const result = applyOps(state, [
      op("SetEmphasis", { segmentId: first, wordId: wordIds[9] ?? "0:9", presetId: "pop" }),
      op("SetEmphasis", { segmentId: first, wordId: "4:4", presetId: "pop" }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range", "unknown-id"]);
  });
});

describe("SetSegmentPosition, HideSegment and SetStyle", () => {
  it("sets and clears a position", () => {
    const { state, segmentIds } = setup();
    const first = segmentIds[0] ?? "";
    const position = { x: 0.5, y: 0.8, anchor: "bottom-center" };
    const set = apply(state, [op("SetSegmentPosition", { segmentId: first, position })]);
    expect(segment(set.state, first).position).toEqual(position);
    const cleared = apply(set.state, [
      op("SetSegmentPosition", { segmentId: first, position: null }),
    ]);
    expect(segment(cleared.state, first).position).toBeUndefined();
  });

  it("hides and unhides", () => {
    const { state, segmentIds } = setup();
    const first = segmentIds[0] ?? "";
    const hidden = apply(state, [op("HideSegment", { segmentId: first, hidden: true })]);
    expect(segment(hidden.state, first).hidden).toBe(true);
    const shown = apply(hidden.state, [op("HideSegment", { segmentId: first, hidden: false })]);
    expect(segment(shown.state, first).hidden).toBeUndefined();
  });

  it("writes the document default and the document override layer", () => {
    const { state } = setup();
    const result = apply(state, [
      op("SetStyle", { scope: "doc", styleRef: "clean-caption", overrides: { fontSize: 64 } }),
    ]);
    expect(result.state.hot.styles.defaultStyleId).toBe("clean-caption");
    expect(result.state.hot.styles.inline).toEqual({
      [DOC_STYLE_OVERRIDE_KEY]: { fontSize: 64 },
    });
  });

  it("replaces a segment's overrides and rejects a malformed scope", () => {
    const { state, segmentIds } = setup();
    const first = segmentIds[0] ?? "";
    const set = apply(state, [
      op("SetStyle", { scope: "segment", segmentId: first, overrides: { colour: "red" } }),
    ]);
    expect(segment(set.state, first).overrides).toEqual({ colour: "red" });
    const cleared = apply(set.state, [
      op("SetStyle", { scope: "segment", segmentId: first, overrides: {} }),
    ]);
    expect(segment(cleared.state, first).overrides).toBeUndefined();
    const rejected = applyOps(state, [
      op("SetStyle", { scope: "segment", styleRef: "punch-pop" }),
      op("SetStyle", { scope: "doc" }),
    ]);
    expect(reasons(rejected)).toEqual(["invalid", "invalid"]);
  });
});

describe("EditWord", () => {
  it("corrects the primary text and one script", () => {
    const { state, wordIds } = setup();
    const result = apply(state, [
      op("EditWord", { wordId: wordIds[0] ?? "0:0", text: "Bhaai" }),
      op("EditWord", { wordId: wordIds[0] ?? "0:0", text: "भाई", script: "native" }),
    ]);
    expect(result.state.words.get("0:0")).toMatchObject({
      t: "Bhaai",
      scripts: { native: "भाई" },
    });
  });

  it("rejects the translated slot, unknown words and deleted words", () => {
    const { state, wordIds } = setup();
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[5] ?? "0:5" })]);
    const result = applyOps(deleted.state, [
      op("EditWord", { wordId: wordIds[0] ?? "0:0", text: "x", script: "translated" }),
      op("EditWord", { wordId: "7:7", text: "x" }),
      op("EditWord", { wordId: wordIds[5] ?? "0:5", text: "x" }),
    ]);
    expect(reasons(result)).toEqual(["invalid", "unknown-id", "stale"]);
  });
});

describe("DeleteWord", () => {
  it("shrinks a segment that started on the word", () => {
    const { state, segmentIds, wordIds } = setup();
    const result = apply(state, [op("DeleteWord", { wordId: wordIds[0] ?? "0:0" })]);
    expect(segment(result.state, segmentIds[0] ?? "")).toMatchObject({
      startWordId: "0:1",
      startMs: 500,
    });
    expect(result.state.words.get("0:0")?.deleted).toBe(true);
    expect(result.state.tombstones.has("0:0")).toBe(true);
  });

  it("shrinks a segment that ended on the word", () => {
    const { state, segmentIds, wordIds } = setup();
    const result = apply(state, [op("DeleteWord", { wordId: wordIds[3] ?? "0:3" })]);
    expect(segment(result.state, segmentIds[0] ?? "")).toMatchObject({
      endWordId: "0:2",
      endMs: 1450,
    });
  });

  it("hides a segment once its last live word is gone", () => {
    const { state, segmentIds, wordIds } = setup({ wordsPerSegment: 1 });
    const result = apply(state, [op("DeleteWord", { wordId: wordIds[0] ?? "0:0" })]);
    const first = segment(result.state, segmentIds[0] ?? "");
    expect(first.hidden).toBe(true);
    expect(first.startWordId).toBe("0:0");
  });

  it("is idempotent and rejects an unknown word", () => {
    const { state, wordIds } = setup();
    const once = apply(state, [op("DeleteWord", { wordId: wordIds[0] ?? "0:0" })]);
    const twice = apply(once.state, [
      op("DeleteWord", { wordId: wordIds[0] ?? "0:0" }),
      op("DeleteWord", { wordId: "3:1" }),
    ]);
    expect(twice.applied).toHaveLength(1);
    expect(reasons(twice)).toEqual(["unknown-id"]);
    expect(toProjection(twice.state)).toEqual(toProjection(once.state));
  });
});

describe("InsertWordAfter", () => {
  it("puts the word in document order inside the neighbours' gap", () => {
    const { state, wordIds } = setup();
    const result = apply(state, [
      op("InsertWordAfter", {
        wordId: wordIds[0] ?? "0:0",
        newWordId: "0:12",
        text: "sach",
        s: 455,
        e: 495,
      }),
    ]);
    expect([...result.state.words.keys()].slice(0, 3)).toEqual(["0:0", "0:12", "0:1"]);
    expect(result.state.words.get("0:12")).toMatchObject({ chunkIdx: 0, offsetMs: 455 });
  });

  it("rejects another chunk, a reused number, an overlap and a dead anchor", () => {
    const { state, wordIds } = setup();
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[6] ?? "0:6" })]);
    const result = applyOps(deleted.state, [
      op("InsertWordAfter", { wordId: "0:0", newWordId: "1:12", text: "x", s: 455, e: 495 }),
      op("InsertWordAfter", { wordId: "0:0", newWordId: "0:4", text: "x", s: 455, e: 495 }),
      op("InsertWordAfter", { wordId: "0:0", newWordId: "0:12", text: "x", s: 455, e: 700 }),
      op("InsertWordAfter", { wordId: "0:0", newWordId: "0:13", text: "x", s: 100, e: 200 }),
      op("InsertWordAfter", { wordId: "0:0", newWordId: "0:14", text: "x", s: 600, e: 500 }),
      op("InsertWordAfter", { wordId: "9:0", newWordId: "9:1", text: "x", s: 0, e: 1 }),
      op("InsertWordAfter", { wordId: "0:6", newWordId: "0:15", text: "x", s: 3455, e: 3495 }),
    ]);
    expect(reasons(result)).toEqual([
      "invalid",
      "invariant",
      "invalid-range",
      "invalid-range",
      "invalid-range",
      "unknown-id",
      "stale",
    ]);
  });

  it("refuses an id that is already tombstoned", () => {
    const { state, wordIds } = setup();
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[1] ?? "0:1" })]);
    const result = applyOps(deleted.state, [
      op("InsertWordAfter", { wordId: "0:0", newWordId: "0:1", text: "x", s: 455, e: 495 }),
    ]);
    expect(reasons(result)).toEqual(["invariant"]);
  });

  it("appends after the last word of the transcript", () => {
    const { state, wordIds } = setup();
    const last = wordIds[wordIds.length - 1] ?? "0:11";
    const result = apply(state, [
      op("InsertWordAfter", { wordId: last, newWordId: "0:12", text: "aur", s: 6000, e: 6400 }),
    ]);
    expect([...result.state.words.keys()].pop()).toBe("0:12");
  });
});

describe("SetWordTiming", () => {
  it("retimes a word inside the gap between its neighbours", () => {
    const { state, wordIds } = setup();
    const result = apply(state, [
      op("SetWordTiming", { wordId: wordIds[1] ?? "0:1", s: 460, e: 940 }),
    ]);
    expect(result.state.words.get("0:1")).toMatchObject({ s: 460, e: 940 });
  });

  it("rejects s >= e", () => {
    const { state, wordIds } = setup();
    const result = applyOps(state, [
      op("SetWordTiming", { wordId: wordIds[1] ?? "0:1", s: 900, e: 900 }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
  });

  it("rejects a range overlapping the previous live word", () => {
    const { state, wordIds } = setup();
    const result = applyOps(state, [
      op("SetWordTiming", { wordId: wordIds[1] ?? "0:1", s: 400, e: 600 }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
  });

  it("rejects a range overlapping the next live word", () => {
    const { state, wordIds } = setup();
    const result = applyOps(state, [
      op("SetWordTiming", { wordId: wordIds[1] ?? "0:1", s: 900, e: 1100 }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
  });

  it("ignores a tombstoned neighbour when checking overlap", () => {
    // Word 1 (500-950) is deleted; word 2 may now retime into its old range —
    // 460-940 would overlap live word 1, but word 1 is a tombstone.
    const { state, wordIds } = setup();
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[1] ?? "0:1" })]);
    const result = apply(deleted.state, [
      op("SetWordTiming", { wordId: wordIds[2] ?? "0:2", s: 460, e: 940 }),
    ]);
    expect(result.state.words.get("0:2")).toMatchObject({ s: 460, e: 940 });
  });

  it("rejects a range that would push the word outside its segment", () => {
    const { state, wordIds } = setup();
    const result = applyOps(state, [
      op("SetWordTiming", { wordId: wordIds[3] ?? "0:3", s: 1500, e: 2000 }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
  });

  it("rejects a range that crosses the chunk boundary", () => {
    const { state, wordIds } = setup();
    const result = applyOps(state, [
      op("SetWordTiming", { wordId: wordIds[0] ?? "0:0", s: -100, e: 50 }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
  });

  it("rejects an unknown word and a deleted word", () => {
    const { state, wordIds } = setup();
    const deleted = applyOps(state, [op("DeleteWord", { wordId: wordIds[1] ?? "0:1" })]);
    const result = applyOps(deleted.state, [
      op("SetWordTiming", { wordId: "7:7", s: 0, e: 100 }),
      op("SetWordTiming", { wordId: wordIds[1] ?? "0:1", s: 0, e: 100 }),
    ]);
    expect(reasons(result)).toEqual(["unknown-id", "stale"]);
  });

  it("leaves segment bounds untouched — they are a separate op", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const before = segment(state, first);
    const result = apply(state, [
      op("SetWordTiming", { wordId: wordIds[1] ?? "0:1", s: 460, e: 940 }),
    ]);
    expect(segment(result.state, first)).toMatchObject({
      startMs: before.startMs,
      endMs: before.endMs,
    });
  });
});

describe("Resegment", () => {
  it("replaces every segment and re-homes style and emphasis", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const prepared = apply(state, [
      op("SetStyle", { scope: "segment", segmentId: first, styleRef: "punch-pop" }),
      op("SetEmphasis", { segmentId: first, wordId: wordIds[1] ?? "0:1", presetId: "pop" }),
    ]);
    const mint = idFactory(700);
    const result = apply(
      prepared.state,
      [op("Resegment", { maxChars: 16, maxLines: 1, minMs: 700, maxMs: 6000 })],
      { newId: mint },
    );
    expect(result.state.segmentOrder.length).toBeGreaterThan(segmentIds.length);
    for (const old of segmentIds) expect(result.state.tombstones.has(old)).toBe(true);
    const withEmphasis = [...result.state.segments.values()].filter(
      (candidate) => candidate.emphasis !== undefined,
    );
    expect(withEmphasis).toHaveLength(1);
    expect(withEmphasis[0]?.emphasis).toEqual([{ wordId: "0:1", presetId: "pop" }]);
    expect(withEmphasis[0]?.styleRef).toBe("punch-pop");
  });

  it("refuses to run without a transcript", () => {
    const fixture = buildFixture();
    const state = fromProjection(fixture.projection);
    const result = applyOps(state, [
      op("Resegment", { maxChars: 24, maxLines: 2, minMs: 700, maxMs: 6000 }),
    ]);
    expect(reasons(result)).toEqual(["invariant"]);
  });
});

function buildPass(passId: string, itemId: string): Pass {
  return {
    passId,
    type: "autocut",
    engine: "autocut@2",
    params: { aggressiveness: 0.4 },
    status: "ready",
    items: [
      { itemId, passId, kind: "cut", startMs: 1000, endMs: 1400, payload: {}, state: "proposed" },
    ],
  };
}

describe("MergePass and DecideItems", () => {
  it("lands a pass from a worker and is idempotent by passId", () => {
    const { state } = setup();
    const mint = idFactory(800);
    const pass = buildPass(mint(), mint());
    const merged = apply(state, [op("MergePass", { pass })], { source: "worker" });
    expect(merged.state.passes.get(pass.passId)?.status).toBe("ready");
    expect(merged.state.items.size).toBe(1);
    const again = apply(merged.state, [op("MergePass", { pass })], { source: "worker" });
    expect(again.applied).toHaveLength(1);
    expect(again.state.items.size).toBe(1);
    expect(toProjection(again.state).passes[0]?.items).toHaveLength(1);
  });

  it("is worker-only", () => {
    const { state } = setup();
    const mint = idFactory(810);
    const result = applyOps(state, [op("MergePass", { pass: buildPass(mint(), mint()) })]);
    expect(reasons(result)).toEqual(["forbidden"]);
  });

  it("rejects an item that claims another pass or an id already in use", () => {
    const { state } = setup();
    const mint = idFactory(820);
    const passId = mint();
    const itemId = mint();
    const stray = buildPass(passId, itemId);
    const mismatched: Pass = {
      ...stray,
      passId: mint(),
      items: stray.items.map((item) => ({ ...item, itemId: mint() })),
    };
    const landed = apply(state, [op("MergePass", { pass: stray })], { source: "worker" });
    const reusedPassId = mint();
    const duplicate: Pass = {
      ...stray,
      passId: reusedPassId,
      items: stray.items.map((item) => ({ ...item, passId: reusedPassId })),
    };
    const result = applyOps(
      landed.state,
      [op("MergePass", { pass: mismatched }), op("MergePass", { pass: duplicate })],
      { source: "worker" },
    );
    expect(reasons(result)).toEqual(["invalid", "invariant"]);
  });

  it("decides items and rejects an unknown one", () => {
    const { state } = setup();
    const mint = idFactory(830);
    const pass = buildPass(mint(), mint());
    const itemId = pass.items[0]?.itemId ?? "";
    const merged = apply(state, [op("MergePass", { pass })], { source: "worker" });
    const decided = apply(merged.state, [
      op("DecideItems", { itemIds: [itemId], state: "accepted" }),
    ]);
    expect(decided.state.items.get(itemId)?.state).toBe("accepted");
    const rejected = applyOps(decided.state, [
      op("DecideItems", { itemIds: [itemId, mint()], state: "rejected" }),
    ]);
    expect(reasons(rejected)).toEqual(["unknown-id"]);
    expect(decided.state.items.get(itemId)?.state).toBe("accepted");
  });
});

describe("SetAudio and SetRender", () => {
  it("merges the audio chain key by key", () => {
    const { state } = setup();
    const first = apply(state, [op("SetAudio", { clean: { enabled: true, targetLufs: -14 } })]);
    const second = apply(first.state, [op("SetAudio", { ducking: { enabled: true, duckDb: -9 } })]);
    expect(second.state.hot.audio).toEqual({
      clean: { enabled: true, targetLufs: -14 },
      ducking: { enabled: true, duckDb: -9 },
    });
  });

  it("stores render presets and ignores an empty SetRender", () => {
    const { state } = setup();
    const result = apply(state, [
      op("SetRender", { presets: ["social-1080x1920"] }),
      op("SetRender", {}),
    ]);
    expect(result.state.hot.render).toEqual({ presets: ["social-1080x1920"] });
    expect(result.applied).toHaveLength(2);
  });
});

describe("the batch itself", () => {
  it("reports a replayed opId as applied without editing the document twice", () => {
    const { state, segmentIds } = setup();
    const batch = [
      op("SetSegmentText", { segmentId: segmentIds[0] ?? "", script: "en", text: "once" }),
    ];
    const first = apply(state, batch);
    const second = apply(first.state, batch);
    expect(second.applied).toEqual(first.applied);
    expect(second.skipped).toEqual(first.applied);
    expect(toProjection(second.state)).toEqual(toProjection(first.state));
  });

  it("keeps applying after a rejected op", () => {
    const { state, segmentIds } = setup();
    const result = applyOps(state, [
      op("HideSegment", { segmentId: idFactory(910)(), hidden: true }),
      op("HideSegment", { segmentId: segmentIds[1] ?? "", hidden: true }),
    ]);
    expect(result.applied).toHaveLength(1);
    expect(reasons(result)).toEqual(["unknown-id"]);
    expect(segment(result.state, segmentIds[1] ?? "").hidden).toBe(true);
  });

  it("stamps the revision the caller won at compare-and-swap", () => {
    const { state, segmentIds } = setup();
    const result = apply(
      state,
      [op("HideSegment", { segmentId: segmentIds[0] ?? "", hidden: true })],
      { revision: 8 },
    );
    expect(result.state.hot.meta.revision).toBe(8);
    const noop = applyOps(state, [op("HideSegment", { segmentId: "nope", hidden: true })], {
      revision: 9,
    });
    expect(noop.state.hot.meta.revision).toBe(7);
  });
});

describe("times recomputed from the words never run backwards", () => {
  it("collapses a segment whose manual end was dragged before its start", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    // The editor dragged this caption to a much later slot than its words.
    const dragged = apply(state, [
      op("SetSegmentBounds", { segmentId: first, startMs: 5000, endMs: 5600 }),
    ]);
    const result = apply(dragged.state, [op("DeleteWord", { wordId: wordIds[3] ?? "0:3" })]);
    expect(segment(result.state, first)).toMatchObject({
      endWordId: "0:2",
      endMs: 1450,
      startMs: 1450,
    });
  });

  it("collapses the head of a split whose manual start was dragged past it", () => {
    const { state, segmentIds, wordIds } = setup();
    const first = segmentIds[0] ?? "";
    const dragged = apply(state, [
      op("SetSegmentBounds", { segmentId: first, startMs: 5000, endMs: 5600 }),
    ]);
    const result = apply(dragged.state, [
      op("SplitSegment", {
        segmentId: first,
        atWordId: wordIds[2] ?? "0:2",
        newSegmentId: idFactory(950)(),
      }),
    ]);
    expect(segment(result.state, first)).toMatchObject({ startMs: 950, endMs: 950 });
  });

  it("hides a segment when deleting its end word leaves nothing before it", () => {
    const { state, segmentIds, wordIds } = setup({ wordsPerSegment: 2 });
    const first = segmentIds[0] ?? "";
    const shrunk = apply(state, [op("DeleteWord", { wordId: wordIds[0] ?? "0:0" })]);
    expect(segment(shrunk.state, first).startWordId).toBe("0:1");
    const result = apply(shrunk.state, [op("DeleteWord", { wordId: wordIds[1] ?? "0:1" })]);
    expect(segment(result.state, first).hidden).toBe(true);
  });

  it("keeps the bounds it was given when there is no transcript to check them against", () => {
    const fixture = buildFixture();
    const state = fromProjection(fixture.projection);
    const first = fixture.segmentIds[0] ?? "";
    const result = applyOps(state, [
      op("SetSegmentBounds", { segmentId: first, startMs: 100, endMs: 200 }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.state.segments.get(first)).toMatchObject({ startMs: 100, endMs: 200 });
  });
});

describe("MergeSegments spans word ranges that seq order does not", () => {
  it("takes the outermost words, not the first and last segment's own ends", () => {
    const { state, segmentIds, wordIds } = setup();
    const [first = "", second = ""] = segmentIds;
    // A client may point a caption at words that sit after its neighbour's:
    // `seq` decides what shows when, and does not have to follow the transcript.
    const crossed = apply(state, [
      op("SetSegmentBounds", {
        segmentId: first,
        startMs: 4000,
        endMs: 5950,
        startWordId: wordIds[8] ?? "0:8",
        endWordId: wordIds[11] ?? "0:11",
      }),
    ]);
    const result = apply(crossed.state, [
      op("MergeSegments", { segmentIds: [first, second], newSegmentId: idFactory(960)() }),
    ]);
    const merged = segment(result.state, result.state.segmentOrder[0] ?? "");
    expect(merged).toMatchObject({
      startWordId: "0:4",
      endWordId: "0:11",
      startMs: 2000,
      endMs: 5950,
    });
  });

  it("keeps the seq-order ends when the transcript is not loaded", () => {
    const fixture = buildFixture();
    const state = fromProjection(fixture.projection);
    const [first = "", second = ""] = fixture.segmentIds;
    const result = applyOps(state, [
      op("MergeSegments", { segmentIds: [first, second], newSegmentId: idFactory(961)() }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.state.segments.get(result.state.segmentOrder[0] ?? "")).toMatchObject({
      startWordId: "0:0",
      endWordId: "0:7",
    });
  });
});

describe("SetProtectedRanges", () => {
  const rangeId = idFactory(970_000);
  const [RANGE_A, RANGE_B, RANGE_C] = [rangeId(), rangeId(), rangeId()];

  it("stores the ranges sorted, with reason user stamped on each", () => {
    const { state } = setup();
    const result = apply(state, [
      op("SetProtectedRanges", {
        ranges: [
          { id: RANGE_B, s: 5_000, e: 6_000 },
          { id: RANGE_A, s: 1_000, e: 2_000 },
        ],
      }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.state.hot.protected).toEqual([
      { id: RANGE_A, s: 1_000, e: 2_000, reason: "user" },
      { id: RANGE_B, s: 5_000, e: 6_000, reason: "user" },
    ]);
  });

  it("merges overlapping and touching ranges into one", () => {
    const { state } = setup();
    const result = apply(state, [
      op("SetProtectedRanges", {
        ranges: [
          { id: RANGE_A, s: 1_000, e: 3_000 },
          { id: RANGE_B, s: 2_500, e: 4_000 },
          { id: RANGE_C, s: 4_000, e: 5_000 },
        ],
      }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.state.hot.protected).toEqual([
      { id: RANGE_A, s: 1_000, e: 5_000, reason: "user" },
    ]);
  });

  it("clamps ranges to the primary media duration and drops what collapses to empty", () => {
    const { state } = setup(); // fixture media durationMs is 90_000
    const result = apply(state, [
      op("SetProtectedRanges", {
        ranges: [
          { id: RANGE_A, s: -100, e: 1_000 },
          { id: RANGE_B, s: 89_500, e: 120_000 },
          { id: RANGE_C, s: 200_000, e: 210_000 },
        ],
      }),
    ]);
    expect(result.rejected).toEqual([]);
    expect(result.state.hot.protected).toEqual([
      { id: RANGE_A, s: 0, e: 1_000, reason: "user" },
      { id: RANGE_B, s: 89_500, e: 90_000, reason: "user" },
    ]);
  });

  it("replaces the whole set wholesale", () => {
    const { state } = setup();
    const first = apply(state, [
      op("SetProtectedRanges", { ranges: [{ id: RANGE_A, s: 1_000, e: 2_000 }] }),
    ]);
    const second = apply(first.state, [
      op("SetProtectedRanges", { ranges: [{ id: RANGE_B, s: 3_000, e: 4_000 }] }),
    ]);
    expect(second.state.hot.protected).toEqual([
      { id: RANGE_B, s: 3_000, e: 4_000, reason: "user" },
    ]);
  });

  it("clears the set with an empty ranges array", () => {
    const { state } = setup();
    const first = apply(state, [
      op("SetProtectedRanges", { ranges: [{ id: RANGE_A, s: 1_000, e: 2_000 }] }),
    ]);
    const second = apply(first.state, [op("SetProtectedRanges", { ranges: [] })]);
    expect(second.state.hot.protected).toEqual([]);
  });

  it("rejects a range with s >= e as invalid-range", () => {
    const { state } = setup();
    const result = applyOps(state, [
      op("SetProtectedRanges", { ranges: [{ id: RANGE_A, s: 2_000, e: 2_000 }] }),
    ]);
    expect(reasons(result)).toEqual(["invalid-range"]);
    expect(result.state.hot.protected ?? []).toEqual([]);
  });
});

describe("normaliseProtectedRanges", () => {
  it("is idempotent: normalising an already-normal set changes nothing", () => {
    const once = normaliseProtectedRanges(
      [
        { id: "a", s: 1_000, e: 2_000 },
        { id: "b", s: 5_000, e: 6_000 },
      ],
      90_000,
    );
    const twice = normaliseProtectedRanges(once, 90_000);
    expect(twice).toEqual(once);
  });

  it("always returns a sorted, non-overlapping set for arbitrary inputs", () => {
    for (const seed of [
      [
        { id: "1", s: 10, e: 5 },
        { id: "2", s: 0, e: 100 },
      ],
      [
        { id: "1", s: -50, e: 50 },
        { id: "2", s: 40, e: 200 },
        { id: "3", s: 300, e: 400 },
      ],
      [],
    ]) {
      const ranges = normaliseProtectedRanges(seed, 90_000);
      for (const range of ranges) {
        expect(range.s).toBeLessThan(range.e);
        expect(range.s).toBeGreaterThanOrEqual(0);
        expect(range.e).toBeLessThanOrEqual(90_000);
      }
      for (let i = 1; i < ranges.length; i += 1) {
        const previous = ranges[i - 1];
        const current = ranges[i];
        if (previous === undefined || current === undefined) continue;
        expect(previous.e).toBeLessThan(current.s);
      }
    }
  });
});
