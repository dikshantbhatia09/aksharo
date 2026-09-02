import { z } from "zod";

/**
 * Wire contracts for the local engine sidecar (`apps/engine`, brief C03a §1).
 * Shapes mirror `apps/model-server`'s `/transcribe` and `/align` (its README,
 * "the word shape is deliberately identical") wherever the two overlap, so a
 * caller's parser does not fork between the cloud and local paths (docs/
 * CONTRACTS.md §3 note in the brief: "mirror its request/response shapes").
 * Local-only fields (`backend`, `tier`, `model` file names) are additive.
 */

export const LatencyTierSchema = z.enum(["A", "B", "C", "D"]);
export type LatencyTier = z.infer<typeof LatencyTierSchema>;

export const EngineBackendKindSchema = z.enum([
  "metal-coreml",
  "vulkan",
  "cuda",
  "cpu",
  "fake",
]);
export type EngineBackendKind = z.infer<typeof EngineBackendKindSchema>;

export const WordTimingSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  word: z.string(),
  probability: z.number().min(0).max(1),
});
export type WordTiming = z.infer<typeof WordTimingSchema>;

export const SegmentSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  text: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const EngineVersionsSchema = z.record(z.string(), z.string());

/** `POST /transcribe` — mirrors `model-server`'s request; local adds nothing. */
export const TranscribeRequestSchema = z.object({
  audio: z.string().min(1),
  language: z.string().optional(),
  wordTimestamps: z.boolean().optional(),
  model: z.string().optional(),
  hints: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
});
export type TranscribeRequest = z.infer<typeof TranscribeRequestSchema>;

export const TranscribeResponseSchema = z.object({
  language: z.string(),
  languageProbability: z.number().min(0).max(1),
  durationS: z.number().nonnegative(),
  model: z.string(),
  requestId: z.string(),
  words: z.array(WordTimingSchema),
  segments: z.array(SegmentSchema),
  engineVersions: EngineVersionsSchema,
  usage: z.object({ audioSeconds: z.number().nonnegative(), model: z.string() }),
  backend: EngineBackendKindSchema,
});
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;

/** WS partial frame streamed during `/transcribe` when `stream: true` (brief §1: "streaming partials over WS"). */
export const TranscribePartialSchema = z.object({
  requestId: z.string(),
  kind: z.literal("partial"),
  words: z.array(WordTimingSchema),
  segment: SegmentSchema,
});
export type TranscribePartial = z.infer<typeof TranscribePartialSchema>;

export const TranscribeDoneSchema = z.object({
  requestId: z.string(),
  kind: z.literal("done"),
  result: TranscribeResponseSchema,
});
export type TranscribeDone = z.infer<typeof TranscribeDoneSchema>;

export const TranscribeErrorSchema = z.object({
  requestId: z.string(),
  kind: z.literal("error"),
  error: z.object({ code: z.string(), message: z.string() }),
});
export type TranscribeError = z.infer<typeof TranscribeErrorSchema>;

export const TranscribeStreamMessageSchema = z.discriminatedUnion("kind", [
  TranscribePartialSchema,
  TranscribeDoneSchema,
  TranscribeErrorSchema,
]);
export type TranscribeStreamMessage = z.infer<typeof TranscribeStreamMessageSchema>;

/** `POST /align` — mirrors `model-server`'s `/align` word shape (D77 aligner licences apply only server-side). */
export const AlignRequestSchema = z.object({
  audio: z.string().min(1),
  words: z.array(z.string()),
  language: z.string(),
  startS: z.number().nonnegative().default(0),
  endS: z.number().nonnegative().optional(),
});
export type AlignRequest = z.infer<typeof AlignRequestSchema>;

export const AlignResponseSchema = z.object({
  language: z.string(),
  model: z.string(),
  licence: z.string(),
  durationS: z.number().nonnegative(),
  requestId: z.string(),
  words: z.array(WordTimingSchema),
  skipped: z.array(z.string()),
  engineVersions: EngineVersionsSchema,
  usage: z.object({ audioSeconds: z.number().nonnegative(), model: z.string() }),
  backend: EngineBackendKindSchema,
});
export type AlignResponse = z.infer<typeof AlignResponseSchema>;

/** `POST /clean` — deep-filter 48 kHz denoise (brief §1). */
export const CleanRequestSchema = z.object({
  audio: z.string().min(1),
});
export type CleanRequest = z.infer<typeof CleanRequestSchema>;

export const CleanResponseSchema = z.object({
  audio: z.string(),
  model: z.literal("deep-filter"),
  sampleRateHz: z.literal(48_000),
  durationS: z.number().nonnegative(),
  requestId: z.string(),
  engineVersions: EngineVersionsSchema,
  backend: EngineBackendKindSchema,
});
export type CleanResponse = z.infer<typeof CleanResponseSchema>;

/** `POST /render` — delegates to `@montaj/render-skia-node` for local burn-in (brief §1). */
export const RenderRequestSchema = z.object({
  drawCommandsPath: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  outputPath: z.string().min(1),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const RenderResponseSchema = z.object({
  outputPath: z.string(),
  frameCount: z.number().int().nonnegative(),
  durationS: z.number().nonnegative(),
  requestId: z.string(),
  engineVersions: EngineVersionsSchema,
  backend: EngineBackendKindSchema,
});
export type RenderResponse = z.infer<typeof RenderResponseSchema>;

/** `GET /models` — installed/available/downloading, disk usage (brief §1/§3). */
export const ModelStateSchema = z.enum(["available", "installed", "downloading", "failed"]);
export type ModelState = z.infer<typeof ModelStateSchema>;

export const ModelStatusSchema = z.object({
  id: z.string(),
  kind: z.enum(["asr", "vad", "denoise", "asr-coreml"]),
  sizeBytes: z.number().int().nonnegative(),
  state: ModelStateSchema,
  progress: z.number().min(0).max(1).optional(),
  sha256: z.string(),
  version: z.string(),
});
export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(ModelStatusSchema),
  diskUsageBytes: z.number().int().nonnegative(),
  diskBudgetBytes: z.number().int().nonnegative(),
  defaultModel: z.string(),
  fallbackModel: z.string(),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export const ModelDownloadRequestSchema = z.object({ modelId: z.string() });
export type ModelDownloadRequest = z.infer<typeof ModelDownloadRequestSchema>;

export const ModelDeleteRequestSchema = z.object({ modelId: z.string() });
export type ModelDeleteRequest = z.infer<typeof ModelDeleteRequestSchema>;

/** `GET /health` — backend, versions, tier (brief §1). */
export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  backend: EngineBackendKindSchema,
  tier: LatencyTierSchema,
  tierReason: z.string(),
  engineVersions: EngineVersionsSchema,
  modelsMissing: z.boolean(),
  uptimeS: z.number().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** The discovery file the engine writes for the desktop shell to find it (T22: 0600, bearer). */
export const EngineDiscoveryFileSchema = z.object({
  port: z.number().int().positive(),
  bearer: z.string().min(32),
  pid: z.number().int().positive(),
  version: z.string(),
  startedAt: z.string(),
});
export type EngineDiscoveryFile = z.infer<typeof EngineDiscoveryFileSchema>;

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
