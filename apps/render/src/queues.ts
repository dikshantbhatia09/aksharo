/**
 * Queue contract for the render service (`docs/CONTRACTS.md` §3).
 *
 * The queue names are the contract's own literals. They are repeated here rather
 * than imported from `apps/api` because this worker is deployed on its own and
 * must not depend on a NestJS app; `queues.test.ts` parses
 * `apps/api/src/jobs/contracts/queue-names.ts` and fails if the two drift, which
 * is the same guard `apps/worker-ai` carries.
 *
 * `montaj` in a queue name is the engineering codename and is correct — the
 * brand rule (CONTRACTS §0) covers user-visible strings only.
 */

import { z } from "zod";

import { RenderManifestSchema } from "@montaj/render-manifest";

export const RENDER_VIDEO_QUEUE = "render.video" as const;
export const RENDER_SUBTITLE_QUEUE = "render.subtitle" as const;

/** The two queues this service consumes. */
export const RENDER_QUEUES = [RENDER_VIDEO_QUEUE, RENDER_SUBTITLE_QUEUE] as const;

export type RenderQueue = (typeof RENDER_QUEUES)[number];

/** Every job's `data` (CONTRACTS §3). */
export interface JobEnvelope<TPayload = unknown> {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly priority: number;
  /** Deduplication key: the same key must never run twice concurrently. */
  readonly jobKey: string;
  /** ISO-8601. */
  readonly createdAt: string;
  readonly payload: TPayload;
}

/** Runtime shape of {@link JobEnvelope}; mirrors `JobEnvelopeSchema` in the API. */
export const JobEnvelopeSchema = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  priority: z.number().int().min(0),
  jobKey: z.string().min(1),
  createdAt: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

/**
 * A caption segment as the projection hands it over.
 *
 * This is CONTRACTS §2's `Segment` minus the fields a renderer cannot use, and
 * it arrives **in the payload** rather than being fetched: a render must draw
 * the revision the manifest was signed for, and a worker that re-read the
 * project would draw whatever it had become by the time the job ran.
 */
export const ProjectedSegmentSchema = z.object({
  id: z.string().min(1),
  seq: z.string().min(1),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
  startWordId: z.string().min(1),
  endWordId: z.string().min(1),
  styleRef: z.string().min(1).optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
  textOverrides: z.record(z.string(), z.string()).optional(),
  emphasis: z
    .array(z.object({ wordId: z.string().min(1), presetId: z.string().min(1) }))
    .optional(),
  hidden: z.boolean().optional(),
  position: z.object({ x: z.number(), y: z.number(), anchor: z.string().min(1) }).optional(),
});

/** One transcript word, in reading order (CONTRACTS §2 `Word`). */
export const ProjectedWordSchema = z.object({
  wid: z.string().min(1),
  s: z.number().int().min(0),
  e: z.number().int().min(0),
  t: z.string(),
  sp: z.string().min(1).optional(),
  filler: z.boolean().optional(),
  deleted: z.boolean().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

/** The read model a render needs, pinned at the manifest's revision. */
export const RenderProjectionSchema = z.object({
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  segments: z.array(ProjectedSegmentSchema),
  words: z.array(ProjectedWordSchema),
  speakerColours: z.record(z.string(), z.string()).optional(),
});

export type RenderProjection = z.infer<typeof RenderProjectionSchema>;

/**
 * `render.video` payload.
 *
 * `07-api-and-contracts.md` writes it as `{edgId, revision, transcriptId,
 * preset, watermark, path: skia|ass}`; every one of those now lives inside the
 * **signed manifest**, because the watermark and the preset are exactly the
 * fields a caller must not be able to choose (THREAT-MODEL T10). What remains in
 * the payload is the manifest itself, the projection snapshot it applies to, and
 * the style documents to draw it with.
 */
export const RenderVideoPayloadSchema = z.object({
  manifest: RenderManifestSchema,
  projection: RenderProjectionSchema,
  /**
   * The StyleDocs the segments reference, by id. Passed in rather than loaded
   * from `@montaj/caption-styles` so a workspace preset or a brand kit renders
   * without this worker knowing anything about either.
   */
  styles: z.record(z.string(), z.unknown()),
  /** `skia` is the only path this service implements; see the README. */
  path: z.enum(["skia", "ass"]).default("skia"),
  /** Which of a word's scripts to burn in. */
  script: z.enum(["roman", "native", "en"]).default("roman"),
  dropFillers: z.boolean().default(false),
});

export type RenderVideoPayload = z.infer<typeof RenderVideoPayloadSchema>;

/** `render.subtitle` payload: the same snapshot, no pixels. */
export const RenderSubtitlePayloadSchema = z.object({
  manifest: RenderManifestSchema,
  projection: RenderProjectionSchema,
});

export type RenderSubtitlePayload = z.infer<typeof RenderSubtitlePayloadSchema>;

/** What a finished `render.video` job reports back (CONTRACTS §3 `result`). */
export interface RenderVideoResult {
  readonly exportId: string;
  /** R2 key under `ws/{workspaceId}/p/{projectId}/exports/` (CONTRACTS §6). */
  readonly outputKey: string;
  readonly outputMs: number;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly videoCodec: string;
  /** Frames the timeline has, and how many of them were actually rasterised. */
  readonly frames: number;
  readonly framesRendered: number;
  readonly renderedAt: string;
  readonly watermarked: boolean;
  /** Wall-clock seconds, so the benchmark can be reproduced from a job row. */
  readonly wallClockSeconds: number;
}

/** What a finished `render.subtitle` job reports back. */
export interface RenderSubtitleResult {
  readonly exportId: string;
  readonly sidecars: readonly {
    readonly format: string;
    readonly script: string;
    readonly key: string;
    readonly sizeBytes: number;
    readonly cues: number;
  }[];
  readonly outputMs: number;
  readonly renderedAt: string;
}

/** Narrow an unknown BullMQ `job.data` to the contract envelope. */
export function isJobEnvelope(value: unknown): value is JobEnvelope {
  return JobEnvelopeSchema.safeParse(value).success;
}

/** BullMQ custom ids may not contain `:` — see the API's `queue.registry.ts`. */
export function bullJobId(jobId: string, attemptId: string): string {
  return `${jobId}-${attemptId}`;
}
