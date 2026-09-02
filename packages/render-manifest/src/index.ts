/**
 * `@montaj/render-manifest` — the server-signed render manifest.
 *
 * `POST /projects/{id}/exports` returns one of these (`05 §5.2`); A21 issues and
 * signs them, `apps/render` verifies one before it draws a frame, and A19 will
 * carry the same document into the browser exporter. The watermark decision and
 * the resolution/length caps live *inside* the signature, so neither can be
 * edited by whoever hands the worker its job payload (THREAT-MODEL T10).
 *
 * ```ts
 * const { manifest } = verifyRenderManifest({ manifest: job.payload.manifest, secret });
 * assertWithinCaps(manifest, timemap.outputDurationMs);
 * ```
 */

export {
  isRenderManifestError,
  RenderManifestError,
  type RenderManifestErrorCode,
} from "./errors.js";

export {
  aspectRatio,
  coverScaleCrop,
  dimensionsFor,
  PRESET_DIMENSIONS,
  type PresetDimensions,
  type ScaleCrop,
  toEven,
} from "./presets.js";

export {
  type Aspect,
  ASPECTS,
  AspectSchema,
  AUDIO_STRATEGIES,
  type AudioSpec,
  AudioSpecSchema,
  type AudioStrategy,
  AudioStrategySchema,
  type Container,
  CONTAINERS,
  ContainerSchema,
  OUTPUT_KINDS,
  type OutputKind,
  OutputKindSchema,
  type OutputSpec,
  OutputSpecSchema,
  RENDER_PRESETS,
  type RenderCaps,
  RenderCapsSchema,
  type RenderManifest,
  RenderManifestSchema,
  type RenderPreset,
  RenderPresetSchema,
  type SourceMedia,
  SourceMediaSchema,
  type StyleSnapshot,
  StyleSnapshotSchema,
  SUBTITLE_FORMATS,
  SUBTITLE_SCRIPTS,
  type SubtitleFormat,
  SubtitleFormatSchema,
  type SubtitleRequest,
  SubtitleRequestSchema,
  type SubtitleScript,
  SubtitleScriptSchema,
  type TimemapEdit,
  TimemapEditSchema,
  type UnsignedRenderManifest,
  UnsignedRenderManifestSchema,
  VIDEO_CODECS,
  type VideoCodec,
  VideoCodecSchema,
  WATERMARK_POSITIONS,
  type Watermark,
  type WatermarkPosition,
  WatermarkPositionSchema,
  WatermarkSchema,
} from "./schema.js";

export {
  canonicalJson,
  MANIFEST_SIGNATURE_DOMAIN,
  type SignatureKey,
  signingPayload,
  signRenderManifest,
  verifyManifestSignature,
  type VerifySignatureInput,
  withSignature,
} from "./signature.js";

export {
  assertWithinCaps,
  type CapViolation,
  capViolations,
  MANIFEST_CLOCK_SKEW_MS,
  type VerifiedRenderManifest,
  verifyRenderManifest,
  type VerifyRenderManifestInput,
} from "./verify.js";
