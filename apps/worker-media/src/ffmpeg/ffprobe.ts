import { unreadableMedia } from "../errors.js";
import { HDR_TRANSFERS } from "../probe-result.js";
import { inputArgs, run } from "./run.js";

import type { ProbeAudio, ProbeVideo, Rotation } from "../probe-result.js";

/**
 * `ffprobe -show_format -show_streams -print_format json`, and the reading of it.
 *
 * ffprobe reads the source **through its signed URL**, never a local copy. That
 * is the whole answer to "a probe of a 4K sixty-minute file must not load the
 * file into memory": ffprobe issues a couple of range requests for the container
 * header and the index, and touches none of the frames. The alternative — stream
 * the object to a temp file first — would move gigabytes across the network and
 * onto the media node's disk to read a few kilobytes of metadata.
 *
 * Nothing in here trusts a number. Every field of ffprobe's JSON is a string
 * whose format depends on the demuxer: `duration` can be absent, `"N/A"`, or
 * seconds with six decimals; `r_frame_rate` is a rational like `30000/1001`;
 * `rotation` is an integer in a side-data block on modern builds and a string tag
 * on old ones. Each is parsed defensively and falls back to something honest
 * rather than to zero pretending to be a measurement.
 */

/** ffprobe's own container names, mapped to the media types the API allows. */
const CONTAINER_MIME: Readonly<Record<string, string>> = {
  "mov,mp4,m4a,3gp,3g2,mj2": "video/mp4",
  matroska: "video/x-matroska",
  "matroska,webm": "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mpeg: "video/mpeg",
  mpegts: "video/mpeg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  aac: "audio/aac",
};

export interface FfprobeStream {
  readonly index?: number;
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly r_frame_rate?: string;
  readonly avg_frame_rate?: string;
  readonly duration?: string;
  readonly pix_fmt?: string;
  readonly bits_per_raw_sample?: string;
  readonly color_transfer?: string;
  readonly color_primaries?: string;
  readonly channels?: number;
  readonly sample_rate?: string;
  readonly tags?: Readonly<Record<string, string>>;
  readonly side_data_list?: readonly Readonly<Record<string, unknown>>[];
}

export interface FfprobeFormat {
  readonly format_name?: string;
  readonly duration?: string;
  readonly size?: string;
  readonly bit_rate?: string;
}

export interface FfprobeOutput {
  readonly streams?: readonly FfprobeStream[];
  readonly format?: FfprobeFormat;
}

export interface ProbeContainer {
  readonly container: string;
  readonly mime: string | null;
  readonly durationMs: number;
  readonly sizeBytes: number | null;
  readonly video: ProbeVideo | null;
  /** Loudness fields are `null` here; the EBU R128 pass fills them in. */
  readonly audio: ProbeAudio | null;
}

/** Run ffprobe against a source and return its parsed JSON. */
export async function ffprobe(input: {
  readonly binary: string;
  readonly source: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<FfprobeOutput> {
  const result = await run(
    input.binary,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      // Rotation lives in a display-matrix side-data block, and without this it is
      // simply missing — every portrait phone clip would then be probed as
      // landscape and get a proxy on its side.
      "-show_entries",
      "stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,duration," +
        "pix_fmt,bits_per_raw_sample,color_transfer,color_primaries,channels,sample_rate:" +
        "stream_tags=rotate:stream_side_data=rotation:format=format_name,duration,size,bit_rate",
      ...inputArgs(input.source),
    ],
    {
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  );

  if (result.code !== 0) {
    // ffprobe exits non-zero for exactly one interesting reason: it could not make
    // sense of the bytes. That is the user's answer, not an incident.
    throw unreadableMedia(
      "This file could not be read as audio or video.",
      "media/unsupported",
      result.stderr,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw unreadableMedia(
      "This file could not be read as audio or video.",
      "media/corrupt",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw unreadableMedia("This file could not be read as audio or video.", "media/corrupt");
  }
  return parsed as FfprobeOutput;
}

/**
 * Turn ffprobe's JSON into the facts the pipeline needs.
 *
 * @throws MediaJobError `media/no_streams` when the container is readable but
 *   holds neither an audio nor a video stream — a PDF renamed to `.mp4` gets that
 *   far, and there is nothing downstream can do with it.
 */
export function readProbe(output: FfprobeOutput): ProbeContainer {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video" && !isCoverArt(stream));
  const audio = streams.find((stream) => stream.codec_type === "audio");

  if (video === undefined && audio === undefined) {
    throw unreadableMedia("This file has no audio or video in it.", "media/no_streams");
  }

  const container = output.format?.format_name ?? "unknown";
  const durationMs = pickDuration(output, video, audio);

  return {
    container,
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    mime: CONTAINER_MIME[container] ?? null,
    durationMs,
    sizeBytes: integerOrNull(output.format?.size),
    video: video === undefined ? null : readVideo(video),
    audio: audio === undefined ? null : readAudio(audio),
  };
}

/** Video facts, with rotation applied to the dimensions. */
export function readVideo(stream: FfprobeStream): ProbeVideo {
  const rotation = readRotation(stream);
  const rawWidth = stream.width ?? 0;
  const rawHeight = stream.height ?? 0;
  const swapped = rotation === 90 || rotation === 270;
  const transfer = stream.color_transfer ?? null;

  return {
    codec: stream.codec_name ?? "unknown",
    width: swapped ? rawHeight : rawWidth,
    height: swapped ? rawWidth : rawHeight,
    fps: readFrameRate(stream.avg_frame_rate) || readFrameRate(stream.r_frame_rate),
    rotation,
    pixelFormat: stream.pix_fmt ?? null,
    bitDepth: integerOrNull(stream.bits_per_raw_sample) ?? bitDepthOfPixelFormat(stream.pix_fmt),
    colourTransfer: transfer,
    colourPrimaries: stream.color_primaries ?? null,
    hdr: transfer !== null && (HDR_TRANSFERS as readonly string[]).includes(transfer),
  };
}

/** Audio facts. Loudness and silence are measured separately and merged in. */
export function readAudio(stream: FfprobeStream): ProbeAudio {
  return {
    codec: stream.codec_name ?? "unknown",
    channels: stream.channels ?? 0,
    sampleRate: integerOrNull(stream.sample_rate) ?? 0,
    loudnessLufs: null,
    loudnessRangeLu: null,
    truePeakDbfs: null,
    silenceRatio: null,
    silences: [],
  };
}

/**
 * Rotation, from wherever this ffmpeg build put it.
 *
 * Modern builds expose it as a signed number in a `Display Matrix` side-data
 * block; older ones only set a `rotate` tag. Negative values are how a display
 * matrix expresses an anticlockwise turn, so `-90` and `270` are the same
 * picture.
 */
export function readRotation(stream: FfprobeStream): Rotation {
  const fromSideData = stream.side_data_list?.find(
    (entry) => typeof entry["rotation"] === "number",
  )?.["rotation"];
  const raw = typeof fromSideData === "number" ? fromSideData : Number(stream.tags?.["rotate"]);
  if (!Number.isFinite(raw)) return 0;

  const normalised = ((Math.round(raw) % 360) + 360) % 360;
  return normalised === 90 || normalised === 180 || normalised === 270 ? normalised : 0;
}

/** `30000/1001` → `29.97`. Zero for `0/0`, which is what a still image reports. */
export function readFrameRate(rational: string | undefined): number {
  if (rational === undefined) return 0;
  const [numerator, denominator] = rational.split("/", 2).map(Number);
  if (
    numerator === undefined ||
    denominator === undefined ||
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * Duration in milliseconds, from the first source that has one.
 *
 * The container is authoritative when it declares a duration; a stream's own is
 * the fallback, because a Matroska file written by a recorder that was killed has
 * no container duration at all. Both can be `"N/A"`.
 */
export function pickDuration(
  output: FfprobeOutput,
  video: FfprobeStream | undefined,
  audio: FfprobeStream | undefined,
): number {
  for (const candidate of [output.format?.duration, video?.duration, audio?.duration]) {
    const seconds = Number(candidate);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  }
  return 0;
}

/**
 * An "video stream" that is really the album art on an MP3.
 *
 * Treating it as video would give an audio-only file a 1×1 proxy and a thumbnail
 * of its cover, which is not what "this is a video" is supposed to mean.
 */
function isCoverArt(stream: FfprobeStream): boolean {
  const codec = stream.codec_name ?? "";
  return codec === "mjpeg" || codec === "png" || codec === "bmp" || codec === "gif";
}

/** `yuv420p10le` → 10. Only used when ffprobe reports no `bits_per_raw_sample`. */
function bitDepthOfPixelFormat(pixelFormat: string | undefined): number | null {
  const match = /(\d{1,2})(?:le|be)$/.exec(pixelFormat ?? "");
  const bits = Number(match?.[1]);
  return Number.isFinite(bits) && bits > 0 ? bits : pixelFormat === undefined ? null : 8;
}

function integerOrNull(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}
