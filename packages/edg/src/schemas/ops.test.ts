import { describe, expect, it } from "vitest";

import { createUlidFactory } from "../ids.js";
import {
  EDG_OP_TYPES,
  type EdgOp,
  type EdgOpType,
  EdgOpSchema,
  EdgOpsEventSchema,
  OpBatchRequestSchema,
  OpBatchResponseSchema,
  OpConflictSchema,
  SetAudioOpSchema,
  SetStyleOpSchema,
  ResegmentOpSchema,
} from "./ops.js";

const newId = createUlidFactory({
  now: () => 1_766_000_000_000,
  randomDigits: () => new Array(16).fill(3),
});

const id = (): string => newId();

/** One valid value per op type; the completeness test keeps this table honest. */
const samples: Record<EdgOpType, EdgOp> = {
  SetSegmentText: {
    opId: id(),
    type: "SetSegmentText",
    segmentId: id(),
    script: "roman",
    text: "Bhai aaj",
  },
  SetSegmentBounds: {
    opId: id(),
    type: "SetSegmentBounds",
    segmentId: id(),
    startMs: 1_200,
    endMs: 4_800,
    startWordId: "0:4",
    endWordId: "0:9",
  },
  SplitSegment: {
    opId: id(),
    type: "SplitSegment",
    segmentId: id(),
    atWordId: "0:7",
    newSegmentId: id(),
  },
  MergeSegments: {
    opId: id(),
    type: "MergeSegments",
    segmentIds: [id(), id()],
    newSegmentId: id(),
  },
  SetEmphasis: { opId: id(), type: "SetEmphasis", segmentId: id(), wordId: "0:3", presetId: "pop" },
  SetSegmentPosition: {
    opId: id(),
    type: "SetSegmentPosition",
    segmentId: id(),
    position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
  },
  HideSegment: { opId: id(), type: "HideSegment", segmentId: id(), hidden: true },
  SetStyle: {
    opId: id(),
    type: "SetStyle",
    scope: "segment",
    segmentId: id(),
    styleRef: "punch-pop",
  },
  EditWord: { opId: id(), type: "EditWord", wordId: "0:3", text: "matlab", script: "roman" },
  DeleteWord: { opId: id(), type: "DeleteWord", wordId: "0:11" },
  InsertWordAfter: {
    opId: id(),
    type: "InsertWordAfter",
    wordId: "0:11",
    newWordId: "0:120",
    text: "bilkul",
    s: 12_000,
    e: 12_400,
  },
  SetProtectedRanges: {
    opId: id(),
    type: "SetProtectedRanges",
    ranges: [{ id: id(), s: 1_000, e: 2_000 }],
  },
  SetWordTiming: { opId: id(), type: "SetWordTiming", wordId: "0:3", s: 1_200, e: 1_600 },
  Resegment: { opId: id(), type: "Resegment", maxChars: 42, maxLines: 2, minMs: 800, maxMs: 5_000 },
  DecideItems: { opId: id(), type: "DecideItems", itemIds: [id()], state: "accepted" },
  EditPassItem: { opId: id(), type: "EditPassItem", itemId: id(), startMs: 17_500, endMs: 18_140 },
  MergePass: {
    opId: id(),
    type: "MergePass",
    pass: {
      passId: id(),
      type: "autocut",
      engine: "autocut@2",
      params: { pacing: "tight" },
      status: "ready",
      items: [
        {
          itemId: id(),
          passId: id(),
          kind: "cut",
          startMs: 17_500,
          endMs: 18_140,
          payload: {},
          state: "proposed",
        },
      ],
    },
  },
  SetAudio: {
    opId: id(),
    type: "SetAudio",
    clean: { enabled: true, preset: "podcast", targetLufs: -14 },
  },
  SetRender: { opId: id(), type: "SetRender", presets: ["social-1080x1920"] },
};

describe("EdgOp union", () => {
  it("covers exactly the op types CONTRACTS §2 lists", () => {
    expect(Object.keys(samples).sort()).toEqual([...EDG_OP_TYPES].sort());
    expect(EDG_OP_TYPES).toHaveLength(19);
  });

  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  it.each(EDG_OP_TYPES.map((type) => [type, samples[type]] as const))(
    "round-trips %s through Zod and JSON",
    (type, sample) => {
      const parsed = EdgOpSchema.parse(sample);
      expect(parsed).toEqual(sample);
      expect(parsed.type).toBe(type);
      const reparsed = EdgOpSchema.parse(JSON.parse(JSON.stringify(parsed)));
      expect(reparsed).toEqual(sample);
    },
  );

  it("rejects an unknown discriminator and a missing opId", () => {
    expect(EdgOpSchema.safeParse({ opId: id(), type: "Nope" }).success).toBe(false);
    expect(EdgOpSchema.safeParse({ type: "DeleteWord", wordId: "0:1" }).success).toBe(false);
    expect(
      EdgOpSchema.safeParse({ opId: "not-a-ulid", type: "DeleteWord", wordId: "0:1" }).success,
    ).toBe(false);
  });

  it("rejects a word id that is not <chunkIdx>:<n>", () => {
    expect(EdgOpSchema.safeParse({ opId: id(), type: "DeleteWord", wordId: "0-1" }).success).toBe(
      false,
    );
  });

  it("clears emphasis and position with null", () => {
    expect(
      EdgOpSchema.safeParse({
        opId: id(),
        type: "SetEmphasis",
        segmentId: id(),
        wordId: "0:3",
        presetId: null,
      }).success,
    ).toBe(true);
    expect(
      EdgOpSchema.safeParse({
        opId: id(),
        type: "SetSegmentPosition",
        segmentId: id(),
        position: null,
      }).success,
    ).toBe(true);
  });
});

describe("op cross-field rules", () => {
  it("requires a segmentId when SetStyle is scoped to a segment", () => {
    const result = SetStyleOpSchema.safeParse({
      opId: id(),
      type: "SetStyle",
      scope: "segment",
      styleRef: "x",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/requires segmentId/);
  });

  it("requires SetStyle to carry a styleRef or overrides", () => {
    expect(SetStyleOpSchema.safeParse({ opId: id(), type: "SetStyle", scope: "doc" }).success).toBe(
      false,
    );
    expect(
      SetStyleOpSchema.safeParse({
        opId: id(),
        type: "SetStyle",
        scope: "doc",
        overrides: { fontSize: 64 },
      }).success,
    ).toBe(true);
  });

  it("requires SetAudio to carry something", () => {
    expect(SetAudioOpSchema.safeParse({ opId: id(), type: "SetAudio" }).success).toBe(false);
    expect(
      SetAudioOpSchema.safeParse({ opId: id(), type: "SetAudio", ducking: { enabled: false } })
        .success,
    ).toBe(true);
  });

  it("accepts a first-class cleanId on SetAudio.clean (B10b)", () => {
    const cleanId = id();
    const result = SetAudioOpSchema.safeParse({
      opId: id(),
      type: "SetAudio",
      clean: { enabled: true, cleanId },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clean?.cleanId).toBe(cleanId);
    }
  });

  it("accepts a null cleanId on SetAudio.clean to clear a clean run", () => {
    expect(
      SetAudioOpSchema.safeParse({
        opId: id(),
        type: "SetAudio",
        clean: { enabled: false, cleanId: null },
      }).success,
    ).toBe(true);
  });

  it("keeps Resegment bounds in order", () => {
    expect(
      ResegmentOpSchema.safeParse({
        opId: id(),
        type: "Resegment",
        maxChars: 42,
        maxLines: 2,
        minMs: 5_000,
        maxMs: 800,
      }).success,
    ).toBe(false);
  });
});

describe("op batch envelopes", () => {
  const ops = [samples.DeleteWord, samples.HideSegment];

  it("parses a batch request", () => {
    const request = { baseRevision: 12, ops, clientOpIds: ops.map((op) => op.opId) };
    expect(OpBatchRequestSchema.parse(request)).toEqual(request);
    expect(
      OpBatchRequestSchema.safeParse({ baseRevision: 0, ops: [], clientOpIds: [] }).success,
    ).toBe(false);
  });

  it("parses a batch response with rejections", () => {
    const response = {
      revision: 13,
      applied: [ops[0]?.opId ?? ""],
      rebased: [],
      rejected: [{ opId: ops[1]?.opId ?? "", reason: "stale", message: "segment was merged away" }],
    };
    expect(OpBatchResponseSchema.parse(response)).toEqual(response);
    expect(
      OpBatchResponseSchema.safeParse({
        ...response,
        rejected: [{ opId: id(), reason: "because" }],
      }).success,
    ).toBe(false);
  });

  it("parses the 409 conflict body and the realtime event", () => {
    expect(OpConflictSchema.parse({ latestRevision: 20, opsSince: ops })).toEqual({
      latestRevision: 20,
      opsSince: ops,
    });
    expect(EdgOpsEventSchema.parse({ revision: 21, ops, source: "premiere" }).source).toBe(
      "premiere",
    );
    expect(EdgOpsEventSchema.safeParse({ revision: 21, ops, source: "fax" }).success).toBe(false);
  });
});
