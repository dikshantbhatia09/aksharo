/**
 * `RenderManifest` — the server-signed instruction a render is allowed to obey.
 *
 * `03-architecture/05-system-architecture.md` §5.2 makes the manifest the first
 * step of every export: `POST /projects/{id}/exports` returns one, and nothing —
 * neither the browser exporter nor this repo's cloud renderer — draws a frame
 * without it. A21 issues manifests; `apps/render` validates them; A19 does the
 * same in the browser.
 *
 * Two properties are the whole point:
 *
 * 1. **The watermark decision is the server's** (THREAT-MODEL T10). It travels
 *    inside the signed document, so a worker cannot be talked into an
 *    unwatermarked render by a job payload.
 * 2. **The caps are the server's** too. `caps` is the entitlement the workspace
 *    actually has, and `assertWithinCaps` refuses an `output` that exceeds it —
 *    the plan ladder is enforced where the pixels are made, not only where the
 *    request was accepted.
 *
 * The document is deliberately a **snapshot**, not a set of pointers: the
 * segments, words and style ids a render used have to stay pinned even if the
 * project moves on while the job sits in a queue.
 */

import { z } from "zod";

/** ULID, per CONTRACTS §0: Crockford base32, 26 characters. */
const Ulid = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a ULID (26 Crockford base32 characters)");

const IsoTimestamp = z.iso.datetime({ offset: true });

const WholeMs = z.number().int().min(0);

/** The four canvases the product ships (CONTRACTS §2, `EdgHot.canvas.aspect`). */
export const ASPECTS = ["9:16", "16:9", "1:1", "4:5"] as const;
export const AspectSchema = z.enum(ASPECTS);
export type Aspect = z.infer<typeof AspectSchema>;

/**
 * Export presets of `05 §5.2`. `custom` carries its own width and height; the
 * rest are named so an operator reading a job payload knows what was asked for.
 */
export const RENDER_PRESETS = ["reels", "shorts", "youtube-4k", "square", "custom"] as const;
export const RenderPresetSchema = z.enum(RENDER_PRESETS);
export type RenderPreset = z.infer<typeof RenderPresetSchema>;

/**
 * Which of the three cloud-only output shapes to produce (`03 F-502`).
 *
 * - `video` composites the captions over the decoded source;
 * - `alpha` emits the caption layer alone with a real alpha channel;
 * - `greenscreen` emits the caption layer over a solid chroma ground, for an
 *   editor that cannot key alpha.
 */
export const OUTPUT_KINDS = ["video", "alpha", "greenscreen"] as const;
export const OutputKindSchema = z.enum(OUTPUT_KINDS);
export type OutputKind = z.infer<typeof OutputKindSchema>;

export const VIDEO_CODECS = ["h264", "prores4444", "vp9"] as const;
export const VideoCodecSchema = z.enum(VIDEO_CODECS);
export type VideoCodec = z.infer<typeof VideoCodecSchema>;

export const CONTAINERS = ["mp4", "mov", "webm"] as const;
export const ContainerSchema = z.enum(CONTAINERS);
export type Container = z.infer<typeof ContainerSchema>;

/** `none` means the output carries no audio track at all. */
export const AUDIO_STRATEGIES = ["passthrough", "replace", "none"] as const;
export const AudioStrategySchema = z.enum(AUDIO_STRATEGIES);
export type AudioStrategy = z.infer<typeof AudioStrategySchema>;

export const WATERMARK_POSITIONS = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
] as const;
export const WatermarkPositionSchema = z.enum(WATERMARK_POSITIONS);
export type WatermarkPosition = z.infer<typeof WatermarkPositionSchema>;

export const SUBTITLE_FORMATS = ["srt", "vtt", "txt", "md", "ass"] as const;
export const SubtitleFormatSchema = z.enum(SUBTITLE_FORMATS);
export type SubtitleFormat = z.infer<typeof SubtitleFormatSchema>;

/** Which of a word's scripts a sidecar is written in (`render-core` `DisplayScript`). */
export const SUBTITLE_SCRIPTS = ["roman", "native", "en"] as const;
export const SubtitleScriptSchema = z.enum(SUBTITLE_SCRIPTS);
export type SubtitleScript = z.infer<typeof SubtitleScriptSchema>;

/** The `@montaj/timemap` edit union, as it travels on the wire (D30). */
export const TimemapEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cut"), startMs: WholeMs, endMs: WholeMs }),
  z.object({
    kind: z.literal("speed"),
    startMs: WholeMs,
    endMs: WholeMs,
    factor: z.number().positive().finite(),
  }),
  z.object({ kind: z.literal("hold"), atMs: WholeMs, durationMs: WholeMs }),
]);
export type TimemapEdit = z.infer<typeof TimemapEditSchema>;

/**
 * One accepted `zoom` or `reframe` pass item's curve, on the **source** clock
 * (B20 addition, CONTRACTS §7 manifest schema).
 *
 * `packed` is the item's keyframe rows — `@montaj/edg` `ZoomPayload`/
 * `ReframePayload`'s `keyframesRef` bytea, base64-encoded for the JSON wire —
 * five little-endian float32s per row, `[tMs, x, y, w, h]` (a normalised
 * `[0,1]` source rectangle; a `zoom` item is reduced to this same shape by
 * `apps/web/lib/passes/keyframes.ts`'s `cropRectFromZoom` before it is packed,
 * so both consumers — the browser exporter and the cloud renderer — read one
 * row format regardless of pass kind). Consumers remap `tMs` onto the output
 * clock themselves with `@montaj/timemap`'s `mapKeyframes`, using the same
 * `TimeMap` this manifest's `timemap.edits` builds — the manifest does not
 * carry pre-remapped output times because a manifest is issued once and the
 * remap is a pure, cheap function of data already on the document.
 */
export const KeyframeTrackSchema = z.object({
  itemId: Ulid,
  kind: z.enum(["zoom", "reframe"]),
  /** Base64 of the packed float32 `[tMs, x, y, w, h]` rows, source-clock `tMs`. */
  packed: z.string().min(1).max(1_000_000),
});
export type KeyframeTrack = z.infer<typeof KeyframeTrackSchema>;

/**
 * The style documents this render is pinned to.
 *
 * `catalogueSnapshotIds` are content ids of the exact StyleDocs used —
 * `"<styleId>@<sha256 prefix>"` as A21 writes them — so a render can be
 * reproduced after the system catalogue has moved on, and so a parity failure
 * can name which documents it was measured against.
 */
export const StyleSnapshotSchema = z.object({
  defaultStyleId: z.string().min(1).max(64),
  catalogueSnapshotIds: z.array(z.string().min(1).max(128)).max(256),
  /** Document-level `SetStyle` overrides (`EdgHot.styles.inline.doc`). */
  documentOverrides: z.record(z.string(), z.unknown()).optional(),
});
export type StyleSnapshot = z.infer<typeof StyleSnapshotSchema>;

/** Where the picture comes from, and how long it is. */
export const SourceMediaSchema = z.object({
  mediaId: Ulid,
  /** `raw` is the S3 original (full quality); `derived` is the R2 540p proxy. */
  bucket: z.enum(["raw", "derived"]),
  /** Object key under CONTRACTS §6. */
  key: z.string().min(1).max(1024),
  durationMs: WholeMs,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().finite().optional(),
});
export type SourceMedia = z.infer<typeof SourceMediaSchema>;

export const OutputSpecSchema = z.object({
  kind: OutputKindSchema,
  preset: RenderPresetSchema,
  aspect: AspectSchema,
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(7680),
  fps: z.number().min(1).max(120),
  container: ContainerSchema,
  videoCodec: VideoCodecSchema,
  /** x264 constant rate factor; ignored by the lossless codecs. */
  crf: z.number().int().min(0).max(51).optional(),
  /** x264 speed preset; `veryfast` per `05 §5.2`. */
  encoderPreset: z.string().min(1).max(32).optional(),
  /** `#RRGGBB` ground for a `greenscreen` output. */
  chromaKey: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const AudioSpecSchema = z.object({
  strategy: AudioStrategySchema,
  /** The `ai.clean` result to use as the replacement track. */
  cleanId: Ulid.optional(),
  /** R2 key of that cleaned track; required whenever `strategy` is `replace`. */
  cleanKey: z.string().min(1).max(1024).optional(),
  codec: z.enum(["aac", "pcm", "opus", "copy"]).default("aac"),
  bitrateKbps: z.number().int().min(32).max(512).default(192),
});
export type AudioSpec = z.infer<typeof AudioSpecSchema>;

/**
 * The watermark, or `null` for an entitled workspace. Only the server may write
 * this field, which is why it sits inside the signature.
 */
export const WatermarkSchema = z.object({
  assetId: z.string().min(1).max(128),
  position: WatermarkPositionSchema,
  opacity: z.number().min(0).max(1),
});
export type Watermark = z.infer<typeof WatermarkSchema>;

/** The workspace's entitlement, enforced by `assertWithinCaps`. */
export const RenderCapsSchema = z.object({
  maxWidth: z.number().int().min(16).max(7680),
  maxHeight: z.number().int().min(16).max(7680),
  maxDurationMs: WholeMs,
  maxFps: z.number().min(1).max(120),
  /** ProRes 4444 / VP9-alpha are a paid entitlement (`04 §Plans`). */
  allowAlpha: z.boolean(),
});
export type RenderCaps = z.infer<typeof RenderCapsSchema>;

export const SubtitleRequestSchema = z.object({
  formats: z.array(SubtitleFormatSchema).min(1).max(SUBTITLE_FORMATS.length),
  scripts: z.array(SubtitleScriptSchema).min(1).max(SUBTITLE_SCRIPTS.length),
  /** Drop the words the cleanup pass marked as fillers. */
  dropFillers: z.boolean().default(false),
});
export type SubtitleRequest = z.infer<typeof SubtitleRequestSchema>;

/**
 * The signed document.
 *
 * `signature` covers every other field (see `signature.ts`), so adding a field
 * here changes the signature of every manifest — which is why `v` exists, and
 * why a mismatched `v` is a parse failure rather than a silent downgrade.
 */
export const RenderManifestSchema = z.object({
  v: z.literal(1),
  manifestId: Ulid,
  /** Single-use value the export-completion callback spends (`07 §exports`). */
  nonce: z.string().regex(/^[0-9a-f]{32,64}$/, "must be lowercase hex"),
  issuedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
  workspaceId: Ulid,
  projectId: Ulid,
  exportId: Ulid,
  edg: z.object({
    edgId: Ulid,
    revision: z.number().int().min(0),
    transcriptId: Ulid.optional(),
  }),
  styles: StyleSnapshotSchema,
  source: SourceMediaSchema,
  timemap: z.object({
    sourceDurationMs: WholeMs,
    edits: z.array(TimemapEditSchema).max(20_000),
    fps: z.number().positive().finite().optional(),
    snapCutsToFrames: z.boolean().default(false),
    /**
     * Accepted zoom/reframe curves (B20). Optional, not defaulted: every manifest
     * built before this field existed — and every fixture/test literal across the
     * repo that predates it — stays a valid `UnsignedRenderManifest` without
     * being touched; a consumer reads `manifest.timemap.keyframes ?? []`.
     */
    keyframes: z.array(KeyframeTrackSchema).max(2_000).optional(),
  }),
  output: OutputSpecSchema,
  audio: AudioSpecSchema,
  watermark: WatermarkSchema.nullable(),
  caps: RenderCapsSchema,
  subtitles: SubtitleRequestSchema.nullable(),
  /** `@montaj/render-core`'s version, so a parity failure names a build. */
  renderCoreVersion: z.string().min(1).max(64),
  signature: z.string().regex(/^[0-9a-f]{64}$/, "must be a hex sha256 HMAC"),
});

export type RenderManifest = z.infer<typeof RenderManifestSchema>;

export const UnsignedRenderManifestSchema = RenderManifestSchema.omit({ signature: true });

/** The manifest without its signature: exactly the fields that get signed. */
export type UnsignedRenderManifest = z.infer<typeof UnsignedRenderManifestSchema>;
