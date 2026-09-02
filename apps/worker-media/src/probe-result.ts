/**
 * What `media.probe` returns in its completion body's `result` (CONTRACTS §3).
 *
 * The worker's half of a contract the API validates
 * (`apps/api/src/media/probe-result.ts`). The two are only ever correct together:
 * a field renamed here is not a compile error over there, it is a measurement the
 * API silently drops. `apps/api/src/media/probe-result.test.ts` parses this file
 * and pins the list, the same guard the queue names have.
 */

/** Rotation in degrees, as a container's display matrix expresses it. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Colour transfer characteristics that mean HDR.
 *
 * `smpte2084` is PQ (HDR10 and Dolby Vision's base layer); `arib-std-b67` is HLG.
 * `bt2020-10` is deliberately absent: it is a wide *gamut* on an SDR curve, and
 * tone-mapping it would wash out a perfectly ordinary picture.
 */
export const HDR_TRANSFERS = ["smpte2084", "arib-std-b67"] as const;

export interface ProbeVideo {
  readonly codec: string;
  /** Display dimensions, rotation applied: a portrait phone clip reads 1080×1920. */
  readonly width: number;
  readonly height: number;
  /** Average frame rate; `0` when the container declares none. */
  readonly fps: number;
  readonly rotation: Rotation;
  readonly pixelFormat: string | null;
  readonly bitDepth: number | null;
  readonly colourTransfer: string | null;
  readonly colourPrimaries: string | null;
  readonly hdr: boolean;
}

/** One stretch of near-silence, from ffmpeg's `silencedetect`. */
export interface SilenceSpan {
  readonly startMs: number;
  readonly endMs: number;
}

export interface ProbeAudio {
  readonly codec: string;
  readonly channels: number;
  readonly sampleRate: number;
  /** EBU R128 integrated loudness, LUFS. `null` when the pass did not run. */
  readonly loudnessLufs: number | null;
  readonly loudnessRangeLu: number | null;
  readonly truePeakDbfs: number | null;
  /** Fraction of the timeline below the silence threshold, 0–1. */
  readonly silenceRatio: number | null;
  /** The longest silences, longest first, capped at {@link MAX_SILENCE_SPANS}. */
  readonly silences: readonly SilenceSpan[];
}

export interface ProbeResult extends Record<string, unknown> {
  readonly mediaId: string;
  /** `ffprobe`'s `format_name`. */
  readonly container: string;
  /** The container's real media type, which overrides the uploader's claim (T7). */
  readonly mime: string | null;
  readonly durationMs: number;
  readonly sizeBytes: number | null;
  readonly hasVideo: boolean;
  readonly hasAudio: boolean;
  readonly video: ProbeVideo | null;
  readonly audio: ProbeAudio | null;
  /** ISO-8601. */
  readonly probedAt: string;
  readonly toolVersion: string | null;
}

/**
 * How many silence spans travel in a probe result.
 *
 * A recording of a lecture with a long pause every slide can have thousands. The
 * *ratio* is the number anything downstream actually branches on; the spans are
 * for a human looking at a job that went wrong, so the longest few are enough and
 * an uncapped array would put a megabyte of JSON in `jobs.result`.
 */
export const MAX_SILENCE_SPANS = 50;

/** Every field the API reads off a probe result; the drift guard pins this list. */
export const PROBE_RESULT_FIELDS = [
  "mediaId",
  "container",
  "mime",
  "durationMs",
  "sizeBytes",
  "hasVideo",
  "hasAudio",
  "video",
  "audio",
  "probedAt",
  "toolVersion",
] as const;

/** What `media.proxy` returns: the keys it wrote, so the API can log them. */
export interface ProxyResult extends Record<string, unknown> {
  readonly mediaId: string;
  readonly proxyKey: string | null;
  readonly audio16kKey: string | null;
  readonly audio48kKey: string | null;
  readonly waveformKey: string | null;
  readonly thumbKeys: readonly string[];
  readonly durationMs: number;
  /** Bytes written to the derived bucket; `usage.egressBytes` on the callback. */
  readonly bytesWritten: number;
  readonly builtAt: string;
}
