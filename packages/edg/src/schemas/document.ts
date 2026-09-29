import { z } from "zod";

import { PassSchema } from "./pass.js";
import {
  AspectSchema,
  JsonObjectSchema,
  MsSchema,
  ScriptIdSchema,
  StyleRefSchema,
  UlidSchema,
} from "./primitives.js";
import { SegmentSchema } from "./segment.js";

/** The EDG schema generation this document was written by (D28). */
export const EDG_SCHEMA_VERSION = 2;

export const EdgMetaSchema = z
  .object({
    edgId: UlidSchema,
    projectId: UlidSchema,
    /** Compare-and-swap counter; one accepted op batch raises it by exactly 1. */
    revision: z.number().int().min(0),
    schemaVersion: z.literal(EDG_SCHEMA_VERSION),
    /** `{asr, aligner, renderCore, localEngine?}` — what produced this state. */
    engineVersions: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: "EdgMeta", title: "EdgMeta" });

/** A media file the document references; media is never modified (05 §4). */
export const MediaRefSchema = z
  .object({
    mediaId: UlidSchema,
    role: z.enum(["primary", "broll", "audio"]),
    durationMs: MsSchema,
    fps: z.number().gt(0).max(480).optional(),
    width: z.number().int().gt(0).optional(),
    height: z.number().int().gt(0).optional(),
  })
  .meta({ id: "MediaRef", title: "MediaRef" });

export const SpeakerSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().max(120).optional(),
    /** `#RRGGBB` swatch used by the transcript column. */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  })
  .meta({ id: "Speaker", title: "Speaker" });

/** Pointer to the transcript revision the segments address (D28). */
export const TranscriptRefSchema = z
  .object({
    transcriptId: UlidSchema,
    revision: z.number().int().min(0),
    /** BCP-47 tag; Hinglish is `hi-Latn`. */
    language: z.string().min(2).max(35),
    scripts: z.array(ScriptIdSchema),
    speakers: z.array(SpeakerSchema).optional(),
  })
  .meta({ id: "TranscriptRef", title: "TranscriptRef" });

export const CanvasSchema = z
  .object({
    aspect: AspectSchema,
    width: z.number().int().gt(0),
    height: z.number().int().gt(0),
    /** Platform-safe margins; shape owned by the editor. */
    safeArea: JsonObjectSchema.optional(),
  })
  .meta({ id: "Canvas", title: "Canvas" });

export const DocStylesSchema = z
  .object({
    defaultStyleId: StyleRefSchema,
    /** Ad-hoc style documents addressed as `inline:<key>` by `styleRef`. */
    inline: JsonObjectSchema.optional(),
    templateId: UlidSchema.optional(),
    brandKitId: UlidSchema.optional(),
  })
  .meta({ id: "DocStyles", title: "DocStyles" });

/** `SetAudio` shape; also the convention for `EdgHot.audio.clean`. */
export const AudioCleanSchema = z
  .object({
    enabled: z.boolean(),
    /**
     * Names the `audio_cleans` row whose 48 kHz track replaces the source
     * audio in exports. `null` clears a previously set clean. First-class as
     * of B10b (CONTRACTS §2, amended 2026-09-03); replaces B10's interim
     * `preset: "b10:<cleanId>"` encoding.
     */
    cleanId: UlidSchema.nullable().optional(),
    preset: z.string().min(1).max(64).optional(),
    /** Integrated loudness target, e.g. -14 LUFS for social (F-308). */
    targetLufs: z.number().min(-40).max(0).optional(),
  })
  .meta({ id: "AudioClean", title: "AudioClean" });

/** Music/SFX ducking under speech; the convention for `EdgHot.audio.ducking`. */
export const AudioDuckingSchema = z
  .object({
    enabled: z.boolean(),
    duckDb: z.number().min(-60).max(0).optional(),
    attackMs: MsSchema.optional(),
    releaseMs: MsSchema.optional(),
  })
  .meta({ id: "AudioDucking", title: "AudioDucking" });

/**
 * A range no pass may cut, zoom or reframe (CONTRACTS §2, added after B18).
 * Only `reason: "user"` rows are ever stored — `emphasis`/`override` rows are
 * derived on the fly by whoever consumes `protected[]` (`passes.service`) and
 * never round-trip through `SetProtectedRanges`.
 */
export const ProtectedRangeSchema = z
  .object({
    id: UlidSchema,
    s: MsSchema,
    e: MsSchema,
    reason: z.enum(["user", "emphasis", "override"]).optional(),
  })
  .meta({ id: "ProtectedRange", title: "ProtectedRange" });

/** The longest overlay text: a hook is seven words or so, and this still bounds a paste. */
export const OVERLAY_TEXT_MAX = 120;

/** The most overlays one document carries: one hook title per clip, with room to grow. */
export const MAX_OVERLAYS = 8;

/** What an overlay is. Only the hook title so far (2026-09-29). */
export const OverlayKindSchema = z
  .enum(["hook-title"])
  .meta({ id: "OverlayKind", title: "OverlayKind" });

/**
 * Something drawn over the video that is not a caption (added 2026-09-29, the
 * Autopilot "auto-finish" work). Today only the hook title: a title card over
 * the first seconds of a clip, the line that makes a viewer stay.
 *
 * On the **source** clock like segments and pass items, so every surface maps
 * it through the same timemap. Only the words and the window are stored: where
 * it sits (the top safe area, off the faces and the captions) and how it looks
 * (the document style's own typeface) are worked out when it is drawn, by
 * `render-core`, so a style change or a new face track moves it too.
 */
export const OverlaySchema = z
  .object({
    id: UlidSchema,
    kind: OverlayKindSchema,
    text: z.string().min(1).max(OVERLAY_TEXT_MAX),
    startMs: MsSchema,
    endMs: MsSchema,
  })
  .meta({ id: "Overlay", title: "Overlay" });

/**
 * The hot document stored in `edg_documents.doc` — under 64 KB, no segments and
 * no pass items (D28). Frozen as `EdgHot` in CONTRACTS §2.
 */
export const EdgHotSchema = z
  .object({
    meta: EdgMetaSchema,
    media: z.array(MediaRefSchema),
    transcript: TranscriptRefSchema,
    canvas: CanvasSchema,
    styles: DocStylesSchema,
    /** `{clean?, ducking?}` by convention; frozen as an open record in CONTRACTS §2. */
    audio: JsonObjectSchema.optional(),
    /** `{presets?}` by convention; frozen as an open record in CONTRACTS §2. */
    render: JsonObjectSchema.optional(),
    /** User-marked ranges no pass may cut, zoom or reframe (CONTRACTS §2). */
    protected: z.array(ProtectedRangeSchema).optional(),
    /**
     * Title cards and the like, drawn over the captions (2026-09-29). Absent on
     * every document written before them, which renders exactly as before.
     */
    overlays: z.array(OverlaySchema).max(MAX_OVERLAYS).optional(),
  })
  .meta({
    id: "EdgHot",
    title: "EdgHot",
    description: "Small hot state of an EDG document (CONTRACTS §2)",
  });

/**
 * The whole document as one value: hot state plus the segment and pass rows.
 * This is what `edg_snapshots.snapshot` stores, what `edg-v2.json` describes and
 * what `validateProjection` checks.
 */
export const EdgProjectionSchema = EdgHotSchema.extend({
  /** Ordered by `seq`; `validateProjection` enforces it. */
  segments: z.array(SegmentSchema),
  passes: z.array(PassSchema),
}).meta({
  id: "EdgProjection",
  title: "EdgProjection",
  description: "Full EDG document view (hot state + segments + passes)",
});

export type EdgMeta = z.infer<typeof EdgMetaSchema>;
export type MediaRef = z.infer<typeof MediaRefSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type TranscriptRef = z.infer<typeof TranscriptRefSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type DocStyles = z.infer<typeof DocStylesSchema>;
export type AudioClean = z.infer<typeof AudioCleanSchema>;
export type AudioDucking = z.infer<typeof AudioDuckingSchema>;
export type ProtectedRange = z.infer<typeof ProtectedRangeSchema>;
export type OverlayKind = z.infer<typeof OverlayKindSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type EdgHot = z.infer<typeof EdgHotSchema>;
export type EdgProjection = z.infer<typeof EdgProjectionSchema>;
