import { z } from "zod";

import { VIDEO_SHAPES, VIDEO_SHAPE_SIZE, type VideoShape } from "./formats.js";
import { REPURPOSE_SCHEMA_VERSION, UlidSchema } from "./schema.js";

/**
 * Compilations (2026-10-03): one video joined from a run's clips - a "best of"
 * - in one shape, with a short fade between clips and, optionally, a title card
 * first. Made by the render service (`render.compilation`) from each clip's
 * CAPTIONED video in that shape, so what it joins is exactly what the run page
 * already plays and downloads; filed as an ordinary export of the run's source
 * project, so export retention and downloads apply to it unchanged.
 *
 * The API decides what to join and in what order; the worker joins it. As with
 * every repurposing queue, the worker revalidates what it is given: the keys it
 * reads must be exports of the job's own workspace, and the length it makes is
 * measured, never taken from the payload.
 */

/** The bounds one compilation is held to. */
export const COMPILATION_LIMITS = Object.freeze({
  /** A compilation of one clip is that clip. */
  minClips: 2,
  maxClips: 20,
  /** The longest joined video, card and fades included. */
  maxOutputMs: 15 * 60_000,
  /** The title card's words: a line or two on the card. */
  titleMax: 80,
  /** How long the title card is up. */
  introMs: 2_000,
  /** Each fade: the end of one clip over the start of the next. */
  fadeMs: 500,
  /** Every compilation is made at this rate, whatever its clips were made at. */
  fps: 30,
});

/** A series (2026-10-03): consecutive clips labelled "Part N of M". */
export const SERIES_LIMITS = Object.freeze({ minClips: 2, maxClips: 10 });

/**
 * Where a clip's captioned video is: an export in the derived store,
 * `ws/{workspaceId}/p/{projectId}/exports/{exportId}.{mp4|mov}` (CONTRACTS §6).
 * Only an export key is accepted, so a payload cannot point the worker at a
 * source original, a face track or another workspace's brand folder.
 */
export const EXPORT_KEY_PATTERN =
  /^ws\/[0-9A-HJKMNP-TV-Z]{26}\/p\/[0-9A-HJKMNP-TV-Z]{26}\/exports\/[0-9A-HJKMNP-TV-Z]{26}\.(mp4|mov)$/;

const ExportKeySchema = z.string().max(200).regex(EXPORT_KEY_PATTERN);
const HexColourSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** One clip of a compilation, in the order it plays. */
export const CompilationClipSchema = z.strictObject({
  clipId: UlidSchema,
  /** The clip's captioned video in the compilation's shape. */
  key: ExportKeySchema,
  /** Its length as its export recorded it; the worker measures the file itself. */
  durationMs: z.int().positive().max(COMPILATION_LIMITS.maxOutputMs),
});

/**
 * The title card (2026-10-03): the brand kit's colours, typeface, handle and
 * logo when the workspace saved one, drawn by render-core's end-card layout so
 * it looks like the card at the end of every branded clip. The logo is read
 * from the job's own workspace (`ws/{workspaceId}/brand/{assetId}.{ext}`).
 */
export const CompilationIntroSchema = z.strictObject({
  title: z.string().trim().min(1).max(COMPILATION_LIMITS.titleMax),
  durationMs: z.int().min(1_000).max(5_000),
  background: HexColourSchema,
  /** The title's colour; black or white, whichever reads, when absent. */
  text: HexColourSchema.optional(),
  /** The handle's colour; the title's when absent. */
  accent: HexColourSchema.optional(),
  handle: z.string().trim().min(1).max(40).optional(),
  fontFamily: z.string().trim().min(1).max(120).optional(),
  logo: z
    .strictObject({
      assetId: UlidSchema,
      format: z.enum(["png", "jpeg", "webp"]),
      width: z.int().min(1).max(8192),
      height: z.int().min(1).max(8192),
    })
    .optional(),
});

/** `render.compilation@1`. */
export const RenderCompilationPayloadSchema = z
  .strictObject({
    schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
    runId: UlidSchema,
    compilationId: UlidSchema,
    /** The export the joined video is filed as (the run's source project). */
    exportId: UlidSchema,
    /** The run's source project: where the export lives. */
    projectId: UlidSchema,
    shape: z.enum(VIDEO_SHAPES),
    width: z.int().min(16).max(3840),
    height: z.int().min(16).max(3840),
    fps: z.int().min(24).max(60),
    fadeMs: z.int().min(0).max(2_000),
    clips: z.array(CompilationClipSchema).min(1).max(COMPILATION_LIMITS.maxClips),
    intro: CompilationIntroSchema.optional(),
  })
  .superRefine((value, context) => {
    const size = VIDEO_SHAPE_SIZE[value.shape];
    if (size.width !== value.width || size.height !== value.height) {
      context.addIssue({
        code: "custom",
        path: ["width"],
        message: `A ${value.shape} compilation is ${String(size.width)} x ${String(size.height)}.`,
      });
    }
    if (new Set(value.clips.map((clip) => clip.clipId)).size !== value.clips.length) {
      context.addIssue({ code: "custom", path: ["clips"], message: "A clip is joined once." });
    }
  });

export const RenderCompilationResultSchema = z.strictObject({
  schemaVersion: z.literal(REPURPOSE_SCHEMA_VERSION),
  compilationId: UlidSchema,
  exportId: UlidSchema,
  outputKey: ExportKeySchema,
  /** Measured from the file the worker made. */
  outputMs: z.int().positive(),
  sizeBytes: z.int().positive().max(10_000_000_000),
  width: z.int().positive(),
  height: z.int().positive(),
  fps: z.int().positive(),
  clips: z.int().positive(),
  intro: z.boolean(),
});

export type CompilationClip = z.infer<typeof CompilationClipSchema>;
export type CompilationIntro = z.infer<typeof CompilationIntroSchema>;
export type RenderCompilationPayload = z.infer<typeof RenderCompilationPayloadSchema>;
export type RenderCompilationResult = z.infer<typeof RenderCompilationResultSchema>;

/**
 * One job per attempt: the export id is new on every attempt, so a retry never
 * dedupes onto the job that failed, and a double click dedupes onto the same.
 */
export function compilationJobKey(compilationId: string, exportId: string): string {
  return `render.compilation:${compilationId}:${exportId}`;
}

/** The export key a compilation is written to: the run's source project. */
export function compilationExportKey(input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly exportId: string;
}): string {
  return `ws/${input.workspaceId}/p/${input.projectId}/exports/${input.exportId}.mp4`;
}

/**
 * How long a compilation comes out, in ms: every clip and the card, on whole
 * frames at `fps`, less one fade for each join - a fade overlaps the end of one
 * part with the start of the next. What the API quotes and caps; the worker
 * measures what it made, and that is what is charged.
 */
export function compilationOutputMs(input: {
  readonly clipsMs: readonly number[];
  readonly introMs?: number;
  readonly fadeMs?: number;
  readonly fps?: number;
}): number {
  const fps = input.fps ?? COMPILATION_LIMITS.fps;
  const frames = (ms: number): number => Math.max(0, Math.round((ms * fps) / 1000));
  const parts = [...(input.introMs === undefined ? [] : [input.introMs]), ...input.clipsMs];
  if (parts.length === 0) return 0;
  const fade = frames(input.fadeMs ?? COMPILATION_LIMITS.fadeMs);
  const total = parts.reduce((sum, ms) => sum + frames(ms), 0) - fade * (parts.length - 1);
  return Math.max(0, Math.round((total * 1000) / fps));
}

/** The pixel size of a compilation in `shape` (the size every clip of that shape is made at). */
export function compilationSize(shape: VideoShape): { width: number; height: number } {
  // eslint-disable-next-line security/detect-object-injection -- a closed enum of shapes
  return { ...VIDEO_SHAPE_SIZE[shape] };
}
