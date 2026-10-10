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
/** A run's clips joined into one video (2026-10-03, `compilation/`). */
export const RENDER_COMPILATION_QUEUE = "render.compilation" as const;

/** The queues this service consumes. */
export const RENDER_QUEUES = [
  RENDER_VIDEO_QUEUE,
  RENDER_SUBTITLE_QUEUE,
  RENDER_COMPILATION_QUEUE,
] as const;

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

export type ProjectedWord = z.infer<typeof ProjectedWordSchema>;

const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/**
 * An image an overlay draws (2026-10-02): a workspace's brand logo, or a
 * picture of its B-roll library (2026-10-05). Only the id and the format
 * travel; the bytes are read from the workspace's own brand or B-roll prefix
 * (`brandAssetKey`, `brollAssetKey`, chosen by the overlay's kind), the
 * workspace taken from the signed manifest, so a payload can never point a
 * render at another tenant's object.
 */
export const OverlayImageSchema = z.object({
  assetId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  format: z.enum(["png", "jpeg", "webp"]),
  width: z.number().int().min(1).max(8192),
  height: z.number().int().min(1).max(8192),
});

export type OverlayImage = z.infer<typeof OverlayImageSchema>;

/**
 * An overlay drawn with the captions (`EdgHot.overlays`), on the source clock
 * like a segment: the hook title (2026-09-29), a brand kit's logo and end card
 * (2026-10-02), and a B-roll cutaway (2026-10-05). Only the kinds this renderer
 * knows are accepted; the document refuses any other. Restated from
 * `@montaj/edg`'s `OverlaySchema` rather than imported (this worker is deployed
 * without it); `queues.test.ts` holds the two to the same samples.
 */
export const ProjectedOverlaySchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("hook-title"),
    text: z.string().min(1).max(120),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    appearance: z
      .object({
        fontFamily: z.string().min(1).max(120).optional(),
        background: HexColourSchema.optional(),
        text: HexColourSchema.optional(),
      })
      .optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("logo"),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    image: OverlayImageSchema,
    corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]),
    sizePct: z.number().min(5).max(40),
    opacity: z.number().min(0.1).max(1),
    marginPct: z.number().min(0).max(15),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("end-card"),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    cta: z.string().max(60).optional(),
    handle: z.string().max(40).optional(),
    background: HexColourSchema,
    text: HexColourSchema.optional(),
    accent: HexColourSchema.optional(),
    fontFamily: z.string().min(1).max(120).optional(),
    image: OverlayImageSchema.optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("b-roll"),
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(0),
    image: OverlayImageSchema,
    mode: z.enum(["full", "pip"]),
    motion: z.enum(["push-in", "pull-out", "pan-left", "pan-right", "none"]),
    startWordId: z
      .string()
      .regex(/^\d+:\d+$/)
      .optional(),
    endWordId: z
      .string()
      .regex(/^\d+:\d+$/)
      .optional(),
    label: z.string().max(80).optional(),
  }),
]);

/** The most overlays a document carries (`@montaj/edg` `MAX_OVERLAYS`: 16 since B-roll, 8 before). */
export const MAX_PROJECTED_OVERLAYS = 16;

/** The read model a render needs, pinned at the manifest's revision. */
export const RenderProjectionSchema = z.object({
  canvas: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  segments: z.array(ProjectedSegmentSchema),
  words: z.array(ProjectedWordSchema),
  speakerColours: z.record(z.string(), z.string()).optional(),
  /** Absent on every payload built before overlays existed, which renders as before. */
  overlays: z.array(ProjectedOverlaySchema).max(MAX_PROJECTED_OVERLAYS).optional(),
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
export const VIDEO_LAYOUT_MODES = [
  "CROP_FACE",
  "SPLIT_TWO_SPEAKER",
  "BLURRED_FIT",
  "STREAMER_SPLIT",
] as const;

export type VideoLayoutMode = (typeof VIDEO_LAYOUT_MODES)[number];

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
  /**
   * Optional high-level video layout preset (Pillar 3 §05).
   * When set to `'BLURRED_FIT'`, captions default to the lower blurred safe zone (`y = 1450px` on `1080 x 1920`).
   */
  layout: z.enum(VIDEO_LAYOUT_MODES).optional(),
});

export type RenderVideoPayload = z.infer<typeof RenderVideoPayloadSchema>;

/** `render.subtitle` payload: the same snapshot, no pixels. */
export const RenderSubtitlePayloadSchema = z.object({
  manifest: RenderManifestSchema,
  projection: RenderProjectionSchema,
});

export type RenderSubtitlePayload = z.infer<typeof RenderSubtitlePayloadSchema>;

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/**
 * A clip's captioned video: an export in the derived store and nothing else
 * (`ws/{ws}/p/{project}/exports/{export}.{mp4|mov}`). The processor also holds
 * the workspace to the job's own.
 */
export const EXPORT_KEY_PATTERN =
  /^ws\/[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-9A-HJKMNP-TV-Z]{26}\/exports\/[0-9A-HJKMNP-TV-Z]{26}\.(mp4|mov)$/;

/** Every shape a clip is made in, and the size a compilation of it is made at. */
export const COMPILATION_SHAPE_SIZE = Object.freeze({
  "9:16": { width: 1080, height: 1920 },
  "4:5": { width: 1080, height: 1350 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
} as const);

/**
 * `render.compilation@1` payload (2026-10-03): a run's clips joined into one
 * video. Restated from `@montaj/repurpose-contracts`' `RenderCompilationPayloadSchema`
 * (this worker is deployed without it); `queues.test.ts` holds the two to the
 * same fixtures.
 */
export const RenderCompilationPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId: UlidSchema,
    compilationId: UlidSchema,
    exportId: UlidSchema,
    projectId: UlidSchema,
    shape: z.enum(["9:16", "4:5", "1:1", "16:9"]),
    width: z.number().int().min(16).max(3840),
    height: z.number().int().min(16).max(3840),
    fps: z.number().int().min(24).max(60),
    fadeMs: z.number().int().min(0).max(2_000),
    clips: z
      .array(
        z.strictObject({
          clipId: UlidSchema,
          key: z.string().max(200).regex(EXPORT_KEY_PATTERN),
          durationMs: z
            .number()
            .int()
            .positive()
            .max(15 * 60_000),
        }),
      )
      .min(1)
      .max(20),
    intro: z
      .strictObject({
        title: z.string().trim().min(1).max(80),
        durationMs: z.number().int().min(1_000).max(5_000),
        background: HexColourSchema,
        text: HexColourSchema.optional(),
        accent: HexColourSchema.optional(),
        handle: z.string().trim().min(1).max(40).optional(),
        fontFamily: z.string().trim().min(1).max(120).optional(),
        logo: z
          .strictObject({
            assetId: UlidSchema,
            format: z.enum(["png", "jpeg", "webp"]),
            width: z.number().int().min(1).max(8192),
            height: z.number().int().min(1).max(8192),
          })
          .optional(),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    const size = COMPILATION_SHAPE_SIZE[value.shape];
    if (size.width !== value.width || size.height !== value.height) {
      context.addIssue({ code: "custom", path: ["width"], message: "not the shape's size" });
    }
    if (new Set(value.clips.map((clip) => clip.clipId)).size !== value.clips.length) {
      context.addIssue({ code: "custom", path: ["clips"], message: "a clip is joined once" });
    }
  });

export type RenderCompilationPayload = z.infer<typeof RenderCompilationPayloadSchema>;

/** What a finished `render.compilation` job reports back. */
export interface RenderCompilationResult {
  readonly schemaVersion: 1;
  readonly compilationId: string;
  readonly exportId: string;
  readonly outputKey: string;
  readonly outputMs: number;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly clips: number;
  readonly intro: boolean;
}

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
