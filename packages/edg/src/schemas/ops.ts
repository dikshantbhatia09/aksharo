import { z } from "zod";

import { AudioCleanSchema, AudioDuckingSchema } from "./document.js";
import { ItemStateSchema, PassSchema } from "./pass.js";
import {
  JsonObjectSchema,
  MsSchema,
  PresetIdSchema,
  ScriptIdSchema,
  StyleRefSchema,
  UlidSchema,
  WordIdSchema,
} from "./primitives.js";
import { PositionSchema } from "./segment.js";

/**
 * The semantic op union (D29, CONTRACTS §2). Ops are **id-addressed** — array
 * indices never appear — so the server can rebase a batch written against an
 * older revision. `opId` is the client-generated ULID that makes a retry
 * idempotent; `type` is the discriminator.
 */
function op<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z
    .object({ opId: UlidSchema, type: z.literal(type), ...shape })
    .meta({ id: type, title: type });
}

/** Replaces the text of one segment in one script. */
export const SetSegmentTextOpSchema = op("SetSegmentText", {
  segmentId: UlidSchema,
  script: ScriptIdSchema,
  text: z.string(),
});

/** Moves a segment's boundaries; word ids follow when the edit came from the transcript. */
export const SetSegmentBoundsOpSchema = op("SetSegmentBounds", {
  segmentId: UlidSchema,
  startMs: MsSchema,
  endMs: MsSchema,
  startWordId: WordIdSchema.optional(),
  endWordId: WordIdSchema.optional(),
});

/** Splits a segment before `atWordId`; the tail becomes `newSegmentId`. */
export const SplitSegmentOpSchema = op("SplitSegment", {
  segmentId: UlidSchema,
  atWordId: WordIdSchema,
  newSegmentId: UlidSchema,
});

/** Merges two or more adjacent segments into `newSegmentId`. */
export const MergeSegmentsOpSchema = op("MergeSegments", {
  segmentIds: z.array(UlidSchema).min(2),
  newSegmentId: UlidSchema,
});

/** Sets or clears (`presetId: null`) the emphasis preset on one word. */
export const SetEmphasisOpSchema = op("SetEmphasis", {
  segmentId: UlidSchema,
  wordId: WordIdSchema,
  presetId: PresetIdSchema.nullable(),
});

/** Moves a segment on the canvas, or clears the override with `null`. */
export const SetSegmentPositionOpSchema = op("SetSegmentPosition", {
  segmentId: UlidSchema,
  position: PositionSchema.nullable(),
});

/** Hides a segment without deleting it. */
export const HideSegmentOpSchema = op("HideSegment", {
  segmentId: UlidSchema,
  hidden: z.boolean(),
});

/** Sets the document default style, or one segment's style and overrides. */
export const SetStyleOpSchema = op("SetStyle", {
  scope: z.enum(["doc", "segment"]),
  segmentId: UlidSchema.optional(),
  styleRef: StyleRefSchema.optional(),
  overrides: JsonObjectSchema.optional(),
}).check((ctx) => {
  const value = ctx.value;
  if (value.scope === "segment" && value.segmentId === undefined) {
    ctx.issues.push({
      code: "custom",
      input: value,
      path: ["segmentId"],
      message: "SetStyle with scope segment requires segmentId",
    });
  }
  if (value.styleRef === undefined && value.overrides === undefined) {
    ctx.issues.push({
      code: "custom",
      input: value,
      path: ["styleRef"],
      message: "SetStyle must carry styleRef, overrides or both",
    });
  }
});

/** Corrects one word; `script` names which writing system was edited. */
export const EditWordOpSchema = op("EditWord", {
  wordId: WordIdSchema,
  text: z.string(),
  script: ScriptIdSchema.optional(),
});

/** Tombstones a word. The id stays addressable for ever (D28). */
export const DeleteWordOpSchema = op("DeleteWord", { wordId: WordIdSchema });

/** Inserts a word after `wordId` using an id the client allocated from `nextWordSeq`. */
export const InsertWordAfterOpSchema = op("InsertWordAfter", {
  wordId: WordIdSchema,
  newWordId: WordIdSchema,
  text: z.string().min(1),
  /** Start, absolute media ms. */
  s: MsSchema,
  /** End, absolute media ms. */
  e: MsSchema,
});

/**
 * Replaces the whole user-marked `protected[]` set wholesale (CONTRACTS §2,
 * added after B18). The engine clamps each range to the media duration, merges
 * overlapping ranges, and stamps `reason: "user"` — the wire shape carries no
 * `reason` because only user-marked rows are ever stored this way.
 */
export const SetProtectedRangesOpSchema = op("SetProtectedRanges", {
  ranges: z.array(z.object({ id: UlidSchema, s: MsSchema, e: MsSchema })),
});

/** Retimes one word; segment bounds are unaffected (they are their own op). */
export const SetWordTimingOpSchema = op("SetWordTiming", {
  wordId: WordIdSchema,
  /** Start, absolute media ms. */
  s: MsSchema,
  /** End, absolute media ms. */
  e: MsSchema,
});

/** Re-runs segmentation over the whole document with new limits. */
export const ResegmentOpSchema = op("Resegment", {
  maxChars: z.number().int().gt(0).max(200),
  maxLines: z.number().int().gt(0).max(6),
  minMs: MsSchema,
  maxMs: MsSchema,
}).check((ctx) => {
  const value = ctx.value;
  if (value.minMs > value.maxMs) {
    ctx.issues.push({
      code: "custom",
      input: value,
      path: ["minMs"],
      message: "minMs must not exceed maxMs",
    });
  }
});

/** Bulk accept/reject/modify of pass proposals. */
export const DecideItemsOpSchema = op("DecideItems", {
  itemIds: z.array(UlidSchema).min(1),
  state: ItemStateSchema,
});

/**
 * User adjusts a proposed or accepted cut/zoom/reframe item's bounds on the
 * timeline (CONTRACTS §2, added 2026-09-03 after B20). Only `proposed` or
 * `accepted` items may be retargeted; the engine clamps the new range to the
 * media duration and to neighbouring accepted items of the same kind, and
 * re-times the item's inline keyframes linearly (a `keyframesRef` curve is
 * left for the worker to re-base on the next pass). Rebase field
 * `item:<itemId>`, last-write-wins; `stale` once the item is rejected.
 */
export const EditPassItemOpSchema = op("EditPassItem", {
  itemId: UlidSchema,
  startMs: MsSchema,
  endMs: MsSchema,
}).check((ctx) => {
  if (ctx.value.startMs >= ctx.value.endMs) {
    ctx.issues.push({
      code: "custom",
      input: ctx.value,
      path: ["startMs"],
      message: "startMs must be before endMs",
    });
  }
});

/** Worker-only: lands a finished pass and its items in the document. */
export const MergePassOpSchema = op("MergePass", { pass: PassSchema });

/** Sets the document audio chain. */
export const SetAudioOpSchema = op("SetAudio", {
  clean: AudioCleanSchema.optional(),
  ducking: AudioDuckingSchema.optional(),
}).check((ctx) => {
  const value = ctx.value;
  if (value.clean === undefined && value.ducking === undefined) {
    ctx.issues.push({
      code: "custom",
      input: value,
      path: ["clean"],
      message: "SetAudio must carry clean, ducking or both",
    });
  }
});

/** Sets the export presets remembered on the document. */
export const SetRenderOpSchema = op("SetRender", {
  presets: z.array(z.string().min(1).max(64)).optional(),
});

/** Every op, discriminated on `type` (CONTRACTS §2). */
export const EdgOpSchema = z
  .discriminatedUnion("type", [
    SetSegmentTextOpSchema,
    SetSegmentBoundsOpSchema,
    SplitSegmentOpSchema,
    MergeSegmentsOpSchema,
    SetEmphasisOpSchema,
    SetSegmentPositionOpSchema,
    HideSegmentOpSchema,
    SetStyleOpSchema,
    EditWordOpSchema,
    DeleteWordOpSchema,
    InsertWordAfterOpSchema,
    SetProtectedRangesOpSchema,
    SetWordTimingOpSchema,
    ResegmentOpSchema,
    DecideItemsOpSchema,
    EditPassItemOpSchema,
    MergePassOpSchema,
    SetAudioOpSchema,
    SetRenderOpSchema,
  ])
  .meta({ id: "EdgOp", title: "EdgOp", description: "Semantic, id-addressed EDG mutation (D29)" });

/** The `type` discriminator values, in the order CONTRACTS §2 lists them. */
export const EDG_OP_TYPES = [
  "SetSegmentText",
  "SetSegmentBounds",
  "SplitSegment",
  "MergeSegments",
  "SetEmphasis",
  "SetSegmentPosition",
  "HideSegment",
  "SetStyle",
  "EditWord",
  "DeleteWord",
  "InsertWordAfter",
  "SetProtectedRanges",
  "SetWordTiming",
  "Resegment",
  "DecideItems",
  "EditPassItem",
  "MergePass",
  "SetAudio",
  "SetRender",
] as const;

/** `POST /projects/{id}/edg/ops` body (D29). */
export const OpBatchRequestSchema = z
  .object({
    /** Revision the client edited against; the server rebases anything older. */
    baseRevision: z.number().int().min(0),
    ops: z.array(EdgOpSchema).min(1).max(500),
    /** Idempotency keys, normally `ops.map((o) => o.opId)`. */
    clientOpIds: z.array(UlidSchema),
  })
  .meta({ id: "OpBatchRequest", title: "OpBatchRequest" });

/**
 * Why an op was dropped (D29). A closed enum: the engine never sends free text.
 *
 * | Reason                  | Raised by | Meaning                                                           |
 * | ----------------------- | --------- | ----------------------------------------------------------------- |
 * | `stale`                 | both      | the target id is tombstoned, or its word was deleted              |
 * | `conflict`              | rebase    | another writer edited the same word or caption text               |
 * | `invalid`               | apply     | the op payload is self-inconsistent (bad scope, duplicate ids)    |
 * | `invalid-range`         | apply     | a time or word range does not fit the document                    |
 * | `not-contiguous`        | apply     | `MergeSegments` over segments that are not neighbours             |
 * | `unknown-id`            | apply     | the segment, word, item or pass id is not in the document         |
 * | `invariant`             | apply     | applying would break a document invariant (id reuse, empty range) |
 * | `rebased-away`          | rebase    | a later revision already wrote the same `(target, field)`         |
 * | `stale-after-resegment` | rebase    | `Resegment` since `baseRevision` replaced every segment id        |
 * | `forbidden`             | apply     | the writer may not submit this op (`MergePass` is worker-only)    |
 * | `rate-limited`          | API       | the workspace write budget is spent                               |
 */
export const OpRejectionReasonSchema = z
  .enum([
    "stale",
    "conflict",
    "invalid",
    "invalid-range",
    "not-contiguous",
    "unknown-id",
    "invariant",
    "rebased-away",
    "stale-after-resegment",
    "forbidden",
    "rate-limited",
  ])
  .meta({ id: "OpRejectionReason", title: "OpRejectionReason" });

export const OpRejectionSchema = z
  .object({
    opId: UlidSchema,
    reason: OpRejectionReasonSchema,
    /** Operator-facing detail; never rendered raw to end users. */
    message: z.string().max(500).optional(),
  })
  .meta({ id: "OpRejection", title: "OpRejection" });

/** `POST /projects/{id}/edg/ops` 200 body (D29). */
export const OpBatchResponseSchema = z
  .object({
    /** The revision after the batch; unchanged when nothing applied. */
    revision: z.number().int().min(0),
    /** `opId`s applied as written. */
    applied: z.array(UlidSchema),
    /** `opId`s applied after a rebase. */
    rebased: z.array(UlidSchema),
    rejected: z.array(OpRejectionSchema),
  })
  .meta({ id: "OpBatchResponse", title: "OpBatchResponse" });

/**
 * 409 body: the client is behind. It carries the ops applied since
 * `baseRevision`, never the document (D29).
 */
export const OpConflictSchema = z
  .object({
    latestRevision: z.number().int().min(0),
    opsSince: z.array(EdgOpSchema),
  })
  .meta({ id: "OpConflict", title: "OpConflict" });

/**
 * Which surface wrote a revision (`edg_revisions.source`). `worker` is the only
 * source allowed to submit `MergePass`.
 */
export const EdgSourceSchema = z
  .enum(["web", "desktop", "premiere", "ae", "resolve", "worker"])
  .meta({ id: "EdgSource", title: "EdgSource" });

/** Realtime `edg.ops` payload (CONTRACTS §7). */
export const EdgOpsEventSchema = z
  .object({
    revision: z.number().int().min(0),
    ops: z.array(EdgOpSchema),
    source: EdgSourceSchema,
  })
  .meta({ id: "EdgOpsEvent", title: "EdgOpsEvent" });

export type SetSegmentTextOp = z.infer<typeof SetSegmentTextOpSchema>;
export type SetSegmentBoundsOp = z.infer<typeof SetSegmentBoundsOpSchema>;
export type SplitSegmentOp = z.infer<typeof SplitSegmentOpSchema>;
export type MergeSegmentsOp = z.infer<typeof MergeSegmentsOpSchema>;
export type SetEmphasisOp = z.infer<typeof SetEmphasisOpSchema>;
export type SetSegmentPositionOp = z.infer<typeof SetSegmentPositionOpSchema>;
export type HideSegmentOp = z.infer<typeof HideSegmentOpSchema>;
export type SetStyleOp = z.infer<typeof SetStyleOpSchema>;
export type EditWordOp = z.infer<typeof EditWordOpSchema>;
export type DeleteWordOp = z.infer<typeof DeleteWordOpSchema>;
export type InsertWordAfterOp = z.infer<typeof InsertWordAfterOpSchema>;
export type SetProtectedRangesOp = z.infer<typeof SetProtectedRangesOpSchema>;
export type SetWordTimingOp = z.infer<typeof SetWordTimingOpSchema>;
export type ResegmentOp = z.infer<typeof ResegmentOpSchema>;
export type DecideItemsOp = z.infer<typeof DecideItemsOpSchema>;
export type EditPassItemOp = z.infer<typeof EditPassItemOpSchema>;
export type MergePassOp = z.infer<typeof MergePassOpSchema>;
export type SetAudioOp = z.infer<typeof SetAudioOpSchema>;
export type SetRenderOp = z.infer<typeof SetRenderOpSchema>;
export type EdgOp = z.infer<typeof EdgOpSchema>;
export type EdgOpType = (typeof EDG_OP_TYPES)[number];
export type OpRejectionReason = z.infer<typeof OpRejectionReasonSchema>;
export type OpRejection = z.infer<typeof OpRejectionSchema>;
export type OpBatchRequest = z.infer<typeof OpBatchRequestSchema>;
export type OpBatchResponse = z.infer<typeof OpBatchResponseSchema>;
export type OpConflict = z.infer<typeof OpConflictSchema>;
export type EdgOpsEvent = z.infer<typeof EdgOpsEventSchema>;
export type EdgSource = z.infer<typeof EdgSourceSchema>;
