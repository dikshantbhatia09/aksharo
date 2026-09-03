/**
 * `ffprobe` in front of every render.
 *
 * The manifest carries the source's dimensions and duration, but they were
 * written when the media was ingested; the file on disk is the thing being
 * encoded. Probing costs milliseconds and catches the cases that otherwise fail
 * a hundred frames in: a source with no video stream, a rotated phone recording
 * whose stored dimensions are transposed, and a file with no audio when the
 * manifest asked for passthrough.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProbedStream {
  readonly kind: "video" | "audio";
  readonly codec: string;
  readonly width?: number;
  readonly height?: number;
  /** Frames per second as a real number, from `r_frame_rate`. */
  readonly fps?: number;
  readonly durationMs?: number;
  /** Display rotation in degrees, from the side data of a phone recording. */
  readonly rotation?: number;
}

export interface ProbeResult {
  readonly durationMs: number;
  readonly video: ProbedStream | null;
  readonly audio: ProbedStream | null;
  /** Width and height **after** rotation, i.e. what the decoder emits. */
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly hasAlpha: boolean;
}

export class ProbeError extends Error {
  public override readonly name = "ProbeError";
  constructor(
    readonly code: "render/unprobeable" | "render/no-video-stream",
    message: string,
  ) {
    super(message);
  }
}

/** `"30000/1001"` → 29.97. */
export function parseRational(value: unknown): number | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const [numerator, denominator] = value.split("/");
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return undefined;
  const fps = top / bottom;
  return fps > 0 ? fps : undefined;
}

/** Pixel formats whose name ends in `a` carry an alpha plane. */
const ALPHA_PIXEL_FORMATS = /^(yuva|rgba|bgra|argb|abgr|gbrap|ya\d|pal8)/;

interface FfprobeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly duration?: string;
  readonly pix_fmt?: string;
  readonly side_data_list?: readonly { readonly rotation?: number }[];
  readonly tags?: Readonly<Record<string, string>>;
}

interface FfprobeOutput {
  readonly streams?: readonly FfprobeStream[];
  readonly format?: { readonly duration?: string };
}

/** Parses `ffprobe -print_format json` output; exported so a test needs no binary. */
export function parseProbeOutput(json: string): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(json) as FfprobeOutput;
  } catch (error) {
    throw new ProbeError(
      "render/unprobeable",
      `ffprobe did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find((stream) => stream.codec_type === "video");
  const audioStream = streams.find((stream) => stream.codec_type === "audio");

  const formatDuration = Number(parsed.format?.duration);
  const durationMs = Number.isFinite(formatDuration) ? Math.round(formatDuration * 1000) : 0;

  const rotation = rotationOf(videoStream);
  const storedWidth = videoStream?.width ?? 0;
  const storedHeight = videoStream?.height ?? 0;
  const transposed = Math.abs(rotation % 180) === 90;

  const video: ProbedStream | null =
    videoStream === undefined
      ? null
      : {
          kind: "video",
          codec: videoStream.codec_name ?? "",
          width: storedWidth,
          height: storedHeight,
          ...(parseRational(videoStream.r_frame_rate ?? videoStream.avg_frame_rate) === undefined
            ? {}
            : { fps: parseRational(videoStream.r_frame_rate ?? videoStream.avg_frame_rate) }),
          ...(Number.isFinite(Number(videoStream.duration))
            ? { durationMs: Math.round(Number(videoStream.duration) * 1000) }
            : {}),
          ...(rotation === 0 ? {} : { rotation }),
        };

  const audio: ProbedStream | null =
    audioStream === undefined
      ? null
      : {
          kind: "audio",
          codec: audioStream.codec_name ?? "",
          ...(Number.isFinite(Number(audioStream.duration))
            ? { durationMs: Math.round(Number(audioStream.duration) * 1000) }
            : {}),
        };

  return {
    durationMs: durationMs > 0 ? durationMs : (video?.durationMs ?? 0),
    video,
    audio,
    displayWidth: transposed ? storedHeight : storedWidth,
    displayHeight: transposed ? storedWidth : storedHeight,
    hasAlpha: ALPHA_PIXEL_FORMATS.test(videoStream?.pix_fmt ?? ""),
  };
}

function rotationOf(stream: FfprobeStream | undefined): number {
  if (stream === undefined) return 0;
  for (const entry of stream.side_data_list ?? []) {
    if (typeof entry.rotation === "number") return normaliseRotation(entry.rotation);
  }
  const tag = stream.tags?.["rotate"];
  if (tag !== undefined) {
    const value = Number(tag);
    if (Number.isFinite(value)) return normaliseRotation(value);
  }
  return 0;
}

function normaliseRotation(value: number): number {
  const wrapped = Math.round(value) % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Runs ffprobe against a local file. */
export async function probeMedia(
  path: string,
  options: { ffprobePath?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ];
  let stdout: string;
  try {
    ({ stdout } = await run(options.ffprobePath ?? "ffprobe", args, {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    throw new ProbeError(
      "render/unprobeable",
      `ffprobe could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = parseProbeOutput(stdout);
  if (result.video === null) {
    throw new ProbeError("render/no-video-stream", `${path} has no video stream to render over`);
  }
  return result;
}

/**
 * `probeMedia`, minus the "must have a video stream" requirement — for a
 * pack asset (an `sfx` cue or `music` bed's own WAV), which is audio-only by
 * construction. D04e's `render/pipeline.ts` uses this to learn a downloaded
 * music bed's own duration (`audio-mix.ts`'s `MusicMixCue.assetDurationMs`),
 * which the manifest track itself does not carry.
 */
export async function probeAudioAsset(
  path: string,
  options: { ffprobePath?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    path,
  ];
  let stdout: string;
  try {
    ({ stdout } = await run(options.ffprobePath ?? "ffprobe", args, {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }));
  } catch (error) {
    throw new ProbeError(
      "render/unprobeable",
      `ffprobe could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseProbeOutput(stdout);
}
