import { z } from "zod";

import {
  AspectSchema,
  ConfidenceSchema,
  GainDbSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  KeyframesInlineSchema,
  KeyframesRefSchema,
  MsSchema,
  OffsetMsSchema,
  PresetIdSchema,
  StyleRefSchema,
  UlidSchema,
  WordIdSchema,
} from "./primitives.js";
import { PositionSchema } from "./segment.js";

/** Pass families (CONTRACTS §2; `"zoom"` added 2026-09-03 after B19b). */
export const PassTypeSchema = z
  .enum(["autocut", "reframe", "zoom", "sfx", "music", "textfx", "prompted"])
  .meta({ id: "PassType", title: "PassType" });

/** Item kinds a pass can propose (CONTRACTS §2). */
export const ItemKindSchema = z
  .enum(["cut", "zoom", "reframe", "sfx", "music", "title"])
  .meta({ id: "ItemKind", title: "ItemKind" });

/** Review state of a proposal (CONTRACTS §2). */
export const ItemStateSchema = z
  .enum(["proposed", "accepted", "rejected", "modified"])
  .meta({ id: "ItemState", title: "ItemState" });

/**
 * Lifecycle of a pass, mirroring the job that produces it: `ready` means the
 * items are on the table for review, `merged` that a `MergePass` op landed them.
 */
export const PassStatusSchema = z
  .enum(["queued", "running", "ready", "merged", "failed", "cancelled"])
  .meta({ id: "PassStatus", title: "PassStatus" });

/** Interpolation for a zoom ramp: `velocity` follows speech energy, `easeInOut` is symmetric. */
export const EasingSchema = z
  .enum(["velocity", "easeInOut"])
  .meta({ id: "Easing", title: "Easing" });

/** Normalised source rectangle, fractions of the frame. */
export const RectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().gt(0).max(1),
    h: z.number().gt(0).max(1),
  })
  .meta({ id: "Rect", title: "Rect" });

/** `cut` carries no payload: the item's `startMs`/`endMs` is the removed range. */
export const CutPayloadSchema = z.object({}).meta({ id: "CutPayload", title: "CutPayload" });

/**
 * Keyframe payload rule (CONTRACTS §2, added 2026-09-03 after B19b): the packed
 * MKF2 curve (`packages/edg/src/passes/keyframes.ts`) rides inline as base64 on
 * `keyframes` when <= 64 KiB, else it is uploaded to derived storage and
 * referenced by `keyframesRef` — readers accept either, so exactly one is
 * required.
 */
const keyframeCarrier = {
  keyframes: KeyframesInlineSchema.optional(),
  keyframesRef: KeyframesRefSchema.optional(),
};

function hasExactlyOneKeyframeField(value: {
  keyframes?: string | undefined;
  keyframesRef?: string | undefined;
}): boolean {
  return (value.keyframes !== undefined) !== (value.keyframesRef !== undefined);
}

export const ZoomPayloadSchema = z
  .object({
    /** Where the zoom lands, normalised to the source frame. */
    target: RectSchema,
    scaleFrom: z.number().gt(0),
    scaleTo: z.number().gt(0),
    easing: EasingSchema,
    ...keyframeCarrier,
  })
  .refine(hasExactlyOneKeyframeField, {
    message: "exactly one of `keyframes` (inline base64) or `keyframesRef` is required",
  })
  .meta({ id: "ZoomPayload", title: "ZoomPayload" });

export const ReframePayloadSchema = z
  .object({
    aspect: AspectSchema,
    ...keyframeCarrier,
  })
  .refine(hasExactlyOneKeyframeField, {
    message: "exactly one of `keyframes` (inline base64) or `keyframesRef` is required",
  })
  .meta({ id: "ReframePayload", title: "ReframePayload" });

export const SfxPayloadSchema = z
  .object({
    /** Library asset ULID; provider ids and URLs never enter the EDG (07). */
    assetId: UlidSchema,
    gainDb: GainDbSchema,
    /** Signed offset from the item start. */
    offsetMs: OffsetMsSchema,
  })
  .meta({ id: "SfxPayload", title: "SfxPayload" });

export const MusicPayloadSchema = z
  .object({
    assetId: UlidSchema,
    gainDb: GainDbSchema,
    /** Gain applied while speech is present; negative ducks the bed. */
    duckDb: z.number().min(-60).max(0),
    fadeInMs: MsSchema,
    fadeOutMs: MsSchema,
  })
  .meta({ id: "MusicPayload", title: "MusicPayload" });

/** Text FX key-phrase classification (D06, `03-architecture/09-ai-pipeline.md` §6). */
export const TextFxIntentSchema = z
  .enum(["title", "stat", "quote", "hook"])
  .meta({ id: "TextFxIntent", title: "TextFxIntent" });

/** The six D06 motion presets, shared by the browser and cloud render engines. */
export const TextFxMotionPresetSchema = z
  .enum(["pop", "slide-up", "typewriter", "underline", "count-up", "fade"])
  .meta({ id: "TextFxMotionPreset", title: "TextFxMotionPreset" });

export const TitlePayloadSchema = z
  .object({
    text: z.string().min(1),
    styleRef: StyleRefSchema,
    position: PositionSchema,
    /** Animation preset ids resolved by `render-core`. */
    animIn: PresetIdSchema,
    animOut: PresetIdSchema,
    /**
     * D06 text-fx fields, added 2026-09-03: a title item minted by the
     * `textfx` pass carries the source key phrase's classification and its
     * anchor into the transcript, on top of the base fields every `title`
     * item already had. Optional so an older/other `title` producer (a
     * manual title, a future non-textfx source) is still a valid payload.
     */
    intent: TextFxIntentSchema.optional(),
    motionPreset: TextFxMotionPresetSchema.optional(),
    /** `Word.wid`s the key phrase was snapped to (its first and last word). */
    anchorWordIds: z.array(WordIdSchema).optional(),
    /** Advisory placement slot; `render-core`'s `placeTitleBox` computes the
     * actual frame-by-frame rectangle from the caption's live safe area. */
    layoutHint: z.enum(["top-third", "upper-left", "upper-right", "centre"]).optional(),
  })
  .meta({ id: "TitlePayload", title: "TitlePayload" });

const passItemBase = {
  itemId: UlidSchema,
  passId: UlidSchema,
  startMs: MsSchema,
  endMs: MsSchema,
  /** Dense curve for this item, stored as packed float32 rows (D28). */
  keyframesRef: KeyframesRefSchema.optional(),
  confidence: ConfidenceSchema.optional(),
  /** Human-readable justification shown in the review UI. */
  reason: z.string().max(500).optional(),
  state: ItemStateSchema,
  /** Licence terms captured when an sfx/music asset was chosen. */
  licenceSnapshot: JsonObjectSchema.optional(),
};

export const CutPassItemSchema = z.object({
  ...passItemBase,
  kind: z.literal("cut"),
  payload: CutPayloadSchema,
});
export const ZoomPassItemSchema = z.object({
  ...passItemBase,
  kind: z.literal("zoom"),
  payload: ZoomPayloadSchema,
});
export const ReframePassItemSchema = z.object({
  ...passItemBase,
  kind: z.literal("reframe"),
  payload: ReframePayloadSchema,
});
export const SfxPassItemSchema = z.object({
  ...passItemBase,
  kind: z.literal("sfx"),
  payload: SfxPayloadSchema,
});
export const MusicPassItemSchema = z.object({
  ...passItemBase,
  kind: z.literal("music"),
  payload: MusicPayloadSchema,
});
export const TitlePassItemSchema = z.object({
  ...passItemBase,
  kind: z.literal("title"),
  payload: TitlePayloadSchema,
});

/**
 * One AI proposal (`edg_pass_items`). The union is discriminated on `kind`, which
 * is what turns CONTRACTS' `payload: Record<string, unknown>` into a checked shape.
 */
export const PassItemSchema = z
  .discriminatedUnion("kind", [
    CutPassItemSchema,
    ZoomPassItemSchema,
    ReframePassItemSchema,
    SfxPassItemSchema,
    MusicPassItemSchema,
    TitlePassItemSchema,
  ])
  .meta({
    id: "PassItem",
    title: "PassItem",
    description: "An AI proposal with a per-kind payload (CONTRACTS §2)",
  });

/** A pass and the items it proposed (`edg_passes` + `edg_pass_items`). */
export const PassSchema = z
  .object({
    passId: UlidSchema,
    type: PassTypeSchema,
    /** Engine that produced the pass, e.g. `autocut@2` or a model id. */
    engine: z.string().min(1).max(120),
    /** Engine parameters as submitted to `POST /projects/{id}/passes`. */
    params: JsonObjectSchema,
    status: PassStatusSchema,
    jobId: UlidSchema.optional(),
    createdAt: IsoDateTimeSchema.optional(),
    items: z.array(PassItemSchema),
  })
  .meta({ id: "Pass", title: "Pass" });

export type PassType = z.infer<typeof PassTypeSchema>;
export type ItemKind = z.infer<typeof ItemKindSchema>;
export type ItemState = z.infer<typeof ItemStateSchema>;
export type PassStatus = z.infer<typeof PassStatusSchema>;
export type Easing = z.infer<typeof EasingSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type CutPayload = z.infer<typeof CutPayloadSchema>;
export type ZoomPayload = z.infer<typeof ZoomPayloadSchema>;
export type ReframePayload = z.infer<typeof ReframePayloadSchema>;
export type SfxPayload = z.infer<typeof SfxPayloadSchema>;
export type MusicPayload = z.infer<typeof MusicPayloadSchema>;
export type TitlePayload = z.infer<typeof TitlePayloadSchema>;
export type TextFxIntent = z.infer<typeof TextFxIntentSchema>;
export type TextFxMotionPreset = z.infer<typeof TextFxMotionPresetSchema>;
export type CutPassItem = z.infer<typeof CutPassItemSchema>;
export type ZoomPassItem = z.infer<typeof ZoomPassItemSchema>;
export type ReframePassItem = z.infer<typeof ReframePassItemSchema>;
export type SfxPassItem = z.infer<typeof SfxPassItemSchema>;
export type MusicPassItem = z.infer<typeof MusicPassItemSchema>;
export type TitlePassItem = z.infer<typeof TitlePassItemSchema>;
export type PassItem = z.infer<typeof PassItemSchema>;
export type Pass = z.infer<typeof PassSchema>;
