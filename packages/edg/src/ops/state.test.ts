import { describe, expect, it } from "vitest";

import { type EdgOp } from "../schemas/ops.js";
import { type Pass } from "../schemas/pass.js";
import { seqBetween } from "../seq.js";
import { buildFixture, idFactory } from "../testing.js";
import { buildWordIndex } from "../transcript-index.js";
import { applyOps } from "./apply.js";
import { SNAPSHOT_EVERY } from "./repository.js";
import { replay, restore, snapshot } from "./snapshot.js";
import {
  APPLIED_OP_ID_LIMIT,
  EdgStateError,
  fromDraft,
  fromProjection,
  hasAppliedOp,
  liveWords,
  nextLiveWord,
  orderedSegments,
  orderIndexOf,
  positionOf,
  previousLiveWord,
  pruneSegment,
  putSegment,
  removeSegment,
  toDraft,
  toProjection,
  toTranscriptChunks,
  wordAfter,
  type EdgState,
} from "./state.js";

const nextOpId = idFactory(600_000);

function op<T extends EdgOp["type"]>(
  type: T,
  fields: Omit<Extract<EdgOp, { type: T }>, "type" | "opId">,
): EdgOp {
  return { opId: nextOpId(), type, ...fields } as EdgOp;
}

function setup() {
  const fixture = buildFixture();
  return { ...fixture, state: fromProjection(fixture.projection, { chunks: fixture.chunks }) };
}

function pass(passId: string, items: Pass["items"]): Pass {
  return { passId, type: "autocut", engine: "autocut@2", params: {}, status: "ready", items };
}

describe("fromProjection and toProjection", () => {
  it("round-trips a projection", () => {
    const { projection, state } = setup();
    expect(toProjection(state)).toEqual(projection);
  });

  it("sorts segments by seq however they arrived", () => {
    const { projection, chunks } = setup();
    const shuffled = { ...projection, segments: [...projection.segments].reverse() };
    const state = fromProjection(shuffled, { chunks });
    expect(toProjection(state).segments).toEqual(projection.segments);
  });

  it("gives passes and items a canonical order", () => {
    const { projection, chunks } = setup();
    const mint = idFactory(300);
    const [passA, passB] = [mint(), mint()].sort();
    const early = {
      itemId: "01J000000000000000000EARLY",
      passId: passA ?? "",
      kind: "cut" as const,
      startMs: 100,
      endMs: 200,
      payload: {},
      state: "proposed" as const,
    };
    const late = {
      itemId: "01J0000000000000000000LATE",
      passId: passA ?? "",
      kind: "cut" as const,
      startMs: 900,
      endMs: 950,
      payload: {},
      state: "proposed" as const,
    };
    const other = {
      itemId: mint(),
      passId: passB ?? "",
      kind: "cut" as const,
      startMs: 10,
      endMs: 20,
      payload: {},
      state: "proposed" as const,
    };

    const forwards = fromProjection(
      { ...projection, passes: [pass(passA ?? "", [late, early]), pass(passB ?? "", [other])] },
      { chunks },
    );
    const backwards = fromProjection(
      { ...projection, passes: [pass(passB ?? "", [other]), pass(passA ?? "", [early, late])] },
      { chunks },
    );
    expect(toProjection(forwards)).toEqual(toProjection(backwards));
    expect(toProjection(forwards).passes[0]?.items.map((item) => item.itemId)).toEqual([
      early.itemId,
      late.itemId,
    ]);
  });

  it("builds the word index from chunks, from an index, or not at all", () => {
    const { projection, chunks } = setup();
    const index = buildWordIndex(chunks);
    expect(fromProjection(projection, { wordIndex: index }).words.size).toBe(index.size);
    expect(fromProjection(projection, { wordIndex: index }).chunks.get(0)).toEqual({
      startMs: 0,
      endMs: 5950,
    });
    expect(
      fromProjection(projection, {
        wordIndex: index,
        chunkBounds: new Map([[0, { startMs: 0, endMs: 90_000 }]]),
      }).chunks.get(0),
    ).toEqual({ startMs: 0, endMs: 90_000 });
    expect(fromProjection(projection).words.size).toBe(0);
  });

  it("throws when the segment order names an id that is not there", () => {
    const { state } = setup();
    const broken: EdgState = { ...state, segmentOrder: [...state.segmentOrder, "missing"] };
    expect(() => toProjection(broken)).toThrow(EdgStateError);
    expect(() => orderedSegments(broken)).toThrow(/missing id/);
  });
});

describe("the transcript inside a state", () => {
  it("gives the chunks back unchanged", () => {
    const { chunks, state } = setup();
    expect(toTranscriptChunks(state)).toEqual(chunks);
  });

  it("keeps a chunk written by an insert, and skips tombstoned words in liveWords", () => {
    const { state, wordIds } = setup();
    const edited = applyOps(state, [
      op("InsertWordAfter", {
        wordId: wordIds[0] ?? "0:0",
        newWordId: "0:12",
        text: "sach",
        s: 455,
        e: 495,
      }),
      op("DeleteWord", { wordId: wordIds[2] ?? "0:2" }),
    ]);
    const chunks = toTranscriptChunks(edited.state);
    expect(chunks[0]?.words.map((word) => word.wid).slice(0, 3)).toEqual(["0:0", "0:12", "0:1"]);
    expect(chunks[0]?.words.some((word) => "chunkIdx" in word)).toBe(false);
    expect(liveWords(edited.state)).toHaveLength(12);
  });

  it("falls back to the words when a chunk declares no bounds", () => {
    const { projection, chunks } = setup();
    const index = buildWordIndex(chunks);
    const state: EdgState = {
      ...fromProjection(projection, { wordIndex: index }),
      chunks: new Map(),
    };
    expect(toTranscriptChunks(state)[0]).toMatchObject({ startMs: 0, endMs: 5950 });
  });
});

describe("the idempotency window", () => {
  it("keeps only the newest ids", () => {
    const { projection, chunks } = setup();
    const mint = idFactory(1);
    const seen = Array.from({ length: APPLIED_OP_ID_LIMIT + 5 }, () => mint());
    const state = fromProjection(projection, { chunks, appliedOpIds: seen });
    expect(state.appliedOpIds.size).toBe(APPLIED_OP_ID_LIMIT);
    expect(hasAppliedOp(state, seen[0] ?? "")).toBe(false);
    expect(hasAppliedOp(state, seen[seen.length - 1] ?? "")).toBe(true);
  });

  it("evicts the oldest id when a new op arrives on a full window", () => {
    const { projection, chunks, segmentIds } = setup();
    const mint = idFactory(1);
    const seen = Array.from({ length: APPLIED_OP_ID_LIMIT }, () => mint());
    const state = fromProjection(projection, { chunks, appliedOpIds: seen });
    const result = applyOps(state, [
      op("HideSegment", { segmentId: segmentIds[0] ?? "", hidden: true }),
    ]);
    expect(result.state.appliedOpIds.size).toBe(APPLIED_OP_ID_LIMIT);
    expect(hasAppliedOp(result.state, seen[0] ?? "")).toBe(false);
    expect(hasAppliedOp(result.state, result.applied[0] ?? "")).toBe(true);
  });
});

describe("pruneSegment", () => {
  it("drops optional fields that carry nothing", () => {
    expect(
      pruneSegment({
        id: "a",
        seq: "V",
        startWordId: "0:0",
        endWordId: "0:1",
        startMs: 0,
        endMs: 1,
        textOverrides: {},
        emphasis: [],
        overrides: {},
        hidden: false,
      }),
    ).toEqual({ id: "a", seq: "V", startWordId: "0:0", endWordId: "0:1", startMs: 0, endMs: 1 });
  });

  it("keeps the ones that carry something", () => {
    const segment = {
      id: "a",
      seq: "V",
      startWordId: "0:0" as const,
      endWordId: "0:1" as const,
      startMs: 0,
      endMs: 1,
      styleRef: "punch-pop",
      textOverrides: { en: "hi" },
      emphasis: [{ wordId: "0:0" as const, presetId: "pop" }],
      position: { x: 0.5, y: 0.5, anchor: "center" },
      overrides: { fontSize: 10 },
      hidden: true,
    };
    expect(pruneSegment(segment)).toEqual(segment);
  });
});

describe("snapshots", () => {
  it("round-trips a state through snapshot and restore", () => {
    const { state, projection } = setup();
    const value = snapshot(state);
    expect(value.schemaVersion).toBe(2);
    expect(value.projection).toEqual(projection);
    const restored = restore(value);
    expect(toProjection(restored)).toEqual(projection);
    expect(restored.words.size).toBe(state.words.size);
  });

  it("omits the transcript when the state has none, and takes it from the caller", () => {
    const { projection, chunks } = setup();
    const value = snapshot(fromProjection(projection));
    expect(value.chunks).toBeUndefined();
    expect(restore(value).words.size).toBe(0);
    expect(restore(value, { chunks }).words.size).toBe(12);
  });

  it("carries the tombstones and the idempotency window a caller supplies", () => {
    const { projection, chunks } = setup();
    const value = snapshot(fromProjection(projection, { chunks }));
    const restored = restore(value, { tombstones: ["dead"], appliedOpIds: ["seen"] });
    expect(restored.tombstones.has("dead")).toBe(true);
    expect(hasAppliedOp(restored, "seen")).toBe(true);
  });

  it("replays an op log over a snapshot", () => {
    const { state, segmentIds } = setup();
    const ops = [
      op("HideSegment", { segmentId: segmentIds[0] ?? "", hidden: true }),
      op("SetSegmentText", { segmentId: segmentIds[1] ?? "", script: "en", text: "replayed" }),
    ];
    const direct = applyOps(state, ops);
    const replayed = replay(snapshot(state), ops);
    expect(replayed.applied).toEqual(direct.applied);
    expect(toProjection(replayed.state)).toEqual(toProjection(direct.state));
  });
});

describe("the repository contract", () => {
  it("fixes the snapshot cadence D28 asks for", () => {
    expect(SNAPSHOT_EVERY).toBe(100);
  });
});

describe("the segment order helpers", () => {
  it("moves a segment when its seq changes under it", () => {
    const { state, segmentIds } = setup();
    const draft = toDraft(state);
    const last = draft.segments.get(segmentIds[2] ?? "");
    if (last === undefined) throw new Error("fixture lost a segment");
    // A fractional key before every other segment moves the row to the front.
    putSegment(draft, {
      ...last,
      seq: seqBetween(undefined, draft.segments.get(segmentIds[0] ?? "")?.seq),
    });
    expect(fromDraft(draft).segmentOrder).toEqual([segmentIds[2], segmentIds[0], segmentIds[1]]);
  });

  it("reports a segment that is not in the order", () => {
    const { state, segmentIds } = setup();
    const draft = toDraft(state);
    // A seq no fixture segment actually holds — not a real neighbour of any
    // of the three `seqSequence(3)` mints, just a mismatch to detect.
    const wrongSeq = "zzzz";
    expect(orderIndexOf(draft, segmentIds[1] ?? "", wrongSeq)).toBe(-1);
    expect(orderIndexOf(draft, "not-a-segment", wrongSeq)).toBe(-1);
  });

  it("removing a segment that was never there is a no-op", () => {
    const { state } = setup();
    const draft = toDraft(state);
    removeSegment(draft, "never-existed");
    expect(fromDraft(draft).segmentOrder).toEqual(state.segmentOrder);
  });

  it("finds nothing past the floor or the ceiling of a range", () => {
    const { state, wordIds } = setup();
    const draft = toDraft(state);
    const first = positionOf(draft, wordIds[0] ?? "0:0") ?? 0;
    expect(previousLiveWord(draft, first, first)).toBeUndefined();
    const last = positionOf(draft, wordIds[11] ?? "0:11") ?? 0;
    expect(nextLiveWord(draft, last, last)).toBeUndefined();
    expect(wordAfter(draft, "9:9")).toBeUndefined();
    expect(wordAfter(draft, wordIds[11] ?? "0:11")).toBeUndefined();
  });
});
