import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { FFMPEG_BASE_ARGS, inputArgs, run } from "../ffmpeg/run.js";

import type { DeriveContext } from "../ffmpeg/derive.js";

/**
 * A filmstrip of frames sampled at a fixed rate — the frame-sampling helper
 * B19b's brief asked worker-media to carry (ruling 4), next to the existing
 * single-frame `grabThumbnail` (`../ffmpeg/derive.ts`).
 *
 * Unlike `grabThumbnail` (one input-seek per frame — cheap for ten frames
 * spread across a whole file), this samples many frames close together at a
 * fixed cadence, so it decodes forward with ffmpeg's own `fps` filter in one
 * process rather than issuing one seek per frame. Every frame is written as a
 * small JPEG (`<= maxWidth` px wide) to `outDir`, named `frame-{00000..}.jpg`
 * in time order — a caller that wants pixels back (rather than files) decodes
 * them itself; this module never buffers a decoded frame in memory.
 *
 * `apps/worker-ai`'s zoom/reframe passes (B19, sampling wired B19b) do not
 * call this — that worker is a separate Python process and samples the proxy
 * itself via ffmpeg directly (`worker_ai.passes.frame_sampling`, module
 * docstring there explains why: decoding this helper's JPEGs back to numpy
 * would need an image-decode dependency worker-ai does not have). This
 * helper exists for a TS consumer that does want encoded frames — a filmstrip
 * preview, or a future thumbnail regenerate — and is a stable, dependency-free
 * (`ffmpeg` only) frame source.
 */

/** Default sampling rate: 10 Hz, the rate B19b's frame/RMS sampling ruling settled on. */
export const SAMPLE_HZ = 10;

/** Default cap on frame width, matching B19b's "CPU-cheap" instruction. */
export const MAX_FRAME_WIDTH = 320;

/** JPEG quality for sampled frames (ffmpeg's `-q:v` scale: 2 best, 31 worst). */
export const SAMPLE_QUALITY = 4;

export interface SampleFramesInput {
  readonly outDir: string;
  readonly hz?: number;
  readonly maxWidth?: number;
}

export interface SampledFrame {
  /** Absolute path to the written JPEG. */
  readonly path: string;
  /** Milliseconds from the start of the source, `index * (1000 / hz)`. */
  readonly tMs: number;
}

export function sampleFramesArgs(input: {
  readonly source: string;
  readonly outPattern: string;
  readonly hz: number;
  readonly maxWidth: number;
}): string[] {
  return [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    ...inputArgs(input.source),
    "-map",
    "0:v:0",
    "-vf",
    `fps=${String(input.hz)},scale=${String(input.maxWidth)}:-2:flags=bicubic`,
    "-q:v",
    String(SAMPLE_QUALITY),
    "-f",
    "image2",
    input.outPattern,
  ];
}

/**
 * Sample `source` at `hz` frames per second (default 10), each downscaled to
 * `<= maxWidth` px wide (default 320), writing JPEGs into `outDir` (created
 * if missing). Returns the written frames in time order.
 *
 * A source shorter than expected, or with an unreadable tail, simply yields
 * fewer frames — the same "a miss is not a failure" rule `grabThumbnail`
 * follows, since a caller only ever wants "what actually decoded".
 */
export async function sampleFrames(
  context: DeriveContext,
  input: SampleFramesInput,
): Promise<SampledFrame[]> {
  const hz = input.hz ?? SAMPLE_HZ;
  const maxWidth = input.maxWidth ?? MAX_FRAME_WIDTH;
  await mkdir(input.outDir, { recursive: true });
  const outPattern = join(input.outDir, "frame-%05d.jpg");

  await run(
    context.binary,
    sampleFramesArgs({ source: context.source, outPattern, hz, maxWidth }),
    {
      timeoutMs: context.timeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  );

  const written = (await readdir(input.outDir))
    .filter((name) => name.startsWith("frame-") && name.endsWith(".jpg"))
    .sort();
  return written.map((name, index) => ({
    path: join(input.outDir, name),
    tMs: Math.round((index * 1000) / hz),
  }));
}
