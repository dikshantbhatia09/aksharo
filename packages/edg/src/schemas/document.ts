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

/** An end card's call to action ("Follow for more"): a line, not a paragraph. */
export const END_CARD_CTA_MAX = 60;

/** An end card's handle ("@yourname"): the longest a platform allows, and then some. */
export const END_CARD_HANDLE_MAX = 40;

/** A brand logo's width, as a share (percent) of the frame's width. */
export const LOGO_SIZE_PCT = { min: 5, max: 40 } as const;

/** A brand logo's distance from the frame's edges, as a share (percent) of its short side. */
export const LOGO_MARGIN_PCT = { min: 0, max: 15 } as const;

/**
 * What an overlay is (2026-09-29, brand kit 2026-10-02): the hook title, a
 * brand logo in a corner, and an end card over the last seconds.
 */
export const OverlayKindSchema = z
  .enum(["hook-title", "logo", "end-card"])
  .meta({ id: "OverlayKind", title: "OverlayKind" });

/**
 * `#RRGGBB`: a brand colour is opaque, so no alpha. No registry `id`: the
 * brand kit's settings (`brand.ts`) are documented in the API's OpenAPI
 * document too, where a JSON Schema `$ref` to a definition would not resolve.
 */
export const HexColourSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected a #RRGGBB colour")
  .meta({ title: "HexColour" });

/**
 * An image an overlay draws (2026-10-02): a workspace's brand logo, stored at
 * `ws/{workspaceId}/brand/{assetId}.{png|jpg|webp}` (the workspace comes from
 * whoever renders, never from the document). The pixel size is the file's own,
 * measured when it was uploaded, so a renderer can size the logo without
 * decoding it first.
 */
export const OverlayImageSchema = z
  .object({
    assetId: UlidSchema,
    format: z.enum(["png", "jpeg", "webp"]),
    width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192),
  })
  .meta({ id: "OverlayImage", title: "OverlayImage" });

/** Which corner of the frame a logo sits in. No registry `id`, for the reason `HexColourSchema` gives. */
export const OverlayCornerSchema = z
  .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
  .meta({ title: "OverlayCorner" });

/**
 * How a hook title looks when a brand kit styled it (2026-10-02). Every field
 * is optional: an absent one is the document style's own (its typeface, its
 * highlight colour for the card, black or white ink, whichever reads).
 */
export const HookTitleAppearanceSchema = z
  .object({
    fontFamily: z.string().min(1).max(120).optional(),
    background: HexColourSchema.optional(),
    text: HexColourSchema.optional(),
  })
  .meta({ id: "HookTitleAppearance", title: "HookTitleAppearance" });

/**
 * The hook title (added 2026-09-29, the Autopilot "auto-finish" work): a title
 * card over the first seconds of a clip, the line that makes a viewer stay.
 *
 * On the **source** clock like segments and pass items, so every surface maps
 * it through the same timemap. Only the words, the window and (with a brand
 * kit) its colours and typeface are stored: where it sits (the top safe area,
 * off the faces, the captions and a logo) is worked out when it is drawn, by
 * `render-core`, so a style change or a new face track moves it too.
 */
export const HookTitleOverlaySchema = z
  .object({
    id: UlidSchema,
    kind: z.literal("hook-title"),
    text: z.string().min(1).max(OVERLAY_TEXT_MAX),
    startMs: MsSchema,
    endMs: MsSchema,
    appearance: HookTitleAppearanceSchema.optional(),
  })
  .meta({ id: "HookTitleOverlay", title: "HookTitleOverlay" });

/**
 * A brand logo in a corner of the frame (2026-10-02, the brand kit). The corner,
 * size, opacity and margin are the kit's; `render-core` keeps it off the
 * captions (moving it to the other corner on the same side, or shrinking it),
 * and does not draw it while an end card is up, which carries its own.
 */
export const LogoOverlaySchema = z
  .object({
    id: UlidSchema,
    kind: z.literal("logo"),
    startMs: MsSchema,
    endMs: MsSchema,
    image: OverlayImageSchema,
    corner: OverlayCornerSchema,
    sizePct: z.number().min(LOGO_SIZE_PCT.min).max(LOGO_SIZE_PCT.max),
    opacity: z.number().min(0.1).max(1),
    marginPct: z.number().min(LOGO_MARGIN_PCT.min).max(LOGO_MARGIN_PCT.max),
  })
  .meta({ id: "LogoOverlay", title: "LogoOverlay" });

/**
 * An end card (2026-10-02, the brand kit): over the last seconds of a clip the
 * frame dims to the card's colour, and a call to action, a handle and the logo
 * come up in the space the captions leave. The clip keeps its length (v1): the
 * card covers its end, it is not added after it.
 */
export const EndCardOverlaySchema = z
  .object({
    id: UlidSchema,
    kind: z.literal("end-card"),
    startMs: MsSchema,
    endMs: MsSchema,
    cta: z.string().max(END_CARD_CTA_MAX).optional(),
    handle: z.string().max(END_CARD_HANDLE_MAX).optional(),
    /** What the frame dims to. */
    background: HexColourSchema,
    /** The call to action's colour; black or white, whichever reads, when absent. */
    text: HexColourSchema.optional(),
    /** The handle's colour; the text colour when absent. */
    accent: HexColourSchema.optional(),
    fontFamily: z.string().min(1).max(120).optional(),
    image: OverlayImageSchema.optional(),
  })
  .meta({ id: "EndCardOverlay", title: "EndCardOverlay" });

/**
 * Something drawn over the video that is not a caption: a hook title, a logo
 * or an end card, told apart by `kind`.
 */
export const OverlaySchema = z
  .discriminatedUnion("kind", [HookTitleOverlaySchema, LogoOverlaySchema, EndCardOverlaySchema])
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
     * Title cards and the like, drawn over the captions (2026-09-29): the hook
     * title, and a brand kit's logo and end card (2026-10-02). Absent on every
     * document written before them, which renders exactly as before.
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
export type OverlayImage = z.infer<typeof OverlayImageSchema>;
export type OverlayCorner = z.infer<typeof OverlayCornerSchema>;
export type HookTitleAppearance = z.infer<typeof HookTitleAppearanceSchema>;
export type HookTitleOverlay = z.infer<typeof HookTitleOverlaySchema>;
export type LogoOverlay = z.infer<typeof LogoOverlaySchema>;
export type EndCardOverlay = z.infer<typeof EndCardOverlaySchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type EdgHot = z.infer<typeof EdgHotSchema>;
export type EdgProjection = z.infer<typeof EdgProjectionSchema>;
