import { MAX_SILENCE_SPANS } from "../probe-result.js";
import { FFMPEG_BASE_ARGS, inputArgs, run } from "./run.js";

import type { SilenceSpan } from "../probe-result.js";

/**
 * The EBU R128 loudness and silence pass, and the parsing of ffmpeg's report.
 *
 * One decode of the **audio only** (`-vn`) to a null muxer: no file is written and
 * no video frame is touched, so a sixty-minute 4K upload costs a sixty-minute
 * audio decode — seconds, not minutes — and nothing at all in memory.
 *
 * Why it lives in the probe rather than the proxy: `09-ai-pipeline` picks a VAD
 * threshold and an ASR route partly on how loud and how sparse a recording is, and
 * that decision happens before a proxy exists. The numbers travel in
 * `jobs.result` because no column has been designed for them yet, which is the
 * honest place for a measurement nothing reads today.
 *
 * The pass is **never fatal**. A file whose audio ffmpeg can demux but not decode
 * still has a perfectly good duration, resolution and codec, and refusing to
 * probe it because the loudness meter was unhappy would be the tail wagging the
 * dog: {@link measureLoudness} returns `null` and the probe carries on.
 */

/** Below this, for at least {@link SILENCE_MIN_S}, counts as silence. */
export const SILENCE_THRESHOLD_DB = -40;

/** Shorter gaps than this are pauses in speech, not silence worth reporting. */
export const SILENCE_MIN_S = 0.5;

export interface LoudnessReport {
  /** Integrated loudness, LUFS. */
  readonly loudnessLufs: number | null;
  /** Loudness range, LU. */
  readonly loudnessRangeLu: number | null;
  readonly truePeakDbfs: number | null;
  /** Fraction of the timeline that is silent, 0–1. `null` when unknown. */
  readonly silenceRatio: number | null;
  /** The longest silences, longest first. */
  readonly silences: readonly SilenceSpan[];
}

export const EMPTY_LOUDNESS: LoudnessReport = Object.freeze({
  loudnessLufs: null,
  loudnessRangeLu: null,
  truePeakDbfs: null,
  silenceRatio: null,
  silences: [],
});

/**
 * Measure loudness and silence, or return {@link EMPTY_LOUDNESS} if anything at
 * all goes wrong.
 */
export async function measureLoudness(input: {
  readonly binary: string;
  readonly source: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<LoudnessReport> {
  const result = await run(
    input.binary,
    [
      ...FFMPEG_BASE_ARGS,
      // `info` and not `error`: the ebur128 summary and every silencedetect line
      // are printed at info level, so a quieter log level measures nothing.
      "-loglevel",
      "info",
      ...inputArgs(input.source),
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-af",
      `ebur128=peak=true,silencedetect=noise=${String(SILENCE_THRESHOLD_DB)}dB:d=${String(SILENCE_MIN_S)}`,
      "-f",
      "null",
      "-",
    ],
    {
      timeoutMs: input.timeoutMs,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  ).catch(() => null);

  if (result === null || result.code !== 0) return EMPTY_LOUDNESS;
  return parseLoudness(result.stderr, input.durationMs);
}

/**
 * Read ffmpeg's stderr report.
 *
 * `ebur128` prints a `Summary:` block at the end:
 *
 * ```
 * [Parsed_ebur128_0 @ ...] Summary:
 *
 *   Integrated loudness:
 *     I:         -23.0 LUFS
 *   Loudness range:
 *     LRA:         6.2 LU
 *   True peak:
 *     Peak:       -1.5 dBFS
 * ```
 *
 * and `silencedetect` prints a pair of lines per gap. The labels are matched
 * rather than the positions, because the block's indentation and the order of its
 * sections have both changed between ffmpeg majors.
 */
export function parseLoudness(stderr: string, durationMs: number): LoudnessReport {
  const silences = parseSilences(stderr);
  const silentMs = silences.reduce((total, span) => total + (span.endMs - span.startMs), 0);

  return {
    loudnessLufs: matchNumber(stderr, /\bI:\s*(-?[\d.]+)\s*LUFS/),
    loudnessRangeLu: matchNumber(stderr, /\bLRA:\s*(-?[\d.]+)\s*LU\b/),
    truePeakDbfs: matchNumber(stderr, /\bPeak:\s*(-?[\d.]+|-?inf)\s*dBFS/),
    silenceRatio:
      durationMs > 0 ? Math.min(1, Math.round((silentMs / durationMs) * 1000) / 1000) : null,
    silences: [...silences]
      .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
      .slice(0, MAX_SILENCE_SPANS)
      .sort((a, b) => a.startMs - b.startMs),
  };
}

/**
 * Pair up `silence_start` / `silence_end` lines.
 *
 * A `silence_start` with no matching end is a file that ended silent — common, and
 * exactly the case that would leave an unbalanced list if the lines were zipped by
 * index instead of matched in order.
 */
export function parseSilences(stderr: string): SilenceSpan[] {
  const spans: SilenceSpan[] = [];
  let open: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start !== null) {
      open = Math.max(0, Math.round(Number(start[1]) * 1000));
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end !== null && open !== null) {
      const endMs = Math.max(open, Math.round(Number(end[1]) * 1000));
      spans.push({ startMs: open, endMs });
      open = null;
    }
  }
  return spans;
}

/** The first capture of `pattern` as a finite number, or `null`. */
function matchNumber(text: string, pattern: RegExp): number | null {
  const raw = pattern.exec(text)?.[1];
  if (raw === undefined) return null;
  const value = Number(raw);
  // `-inf dBFS` is what a completely silent track peaks at; it is true and it is
  // not a number a JSON column can hold.
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

/**
 * Platform targets according to ITU-R BS.1770-4 / EBU R128:
 * - YouTube / YouTube Shorts: -14.0 LUFS, -1.0 dBTP, LRA 7.0
 * - TikTok & Instagram Reels / Stories: -15.0 LUFS, -1.0 dBTP, LRA 7.0
 * - Default: -14.0 LUFS, -1.0 dBTP, LRA 7.0
 */
export interface LoudnessTargetSpec {
  /** Target integrated loudness in LUFS (e.g. -14.0 for YouTube, -15.0 for TikTok/Reels). */
  readonly targetI: number;
  /** Maximum true peak in dBTP (default -1.0 dBTP). */
  readonly targetTp: number;
  /** Target loudness range in LU (default 7.0 LU). */
  readonly targetLra: number;
}

export const PLATFORM_LOUDNESS_TARGETS: Readonly<Record<string, LoudnessTargetSpec>> = Object.freeze({
  "youtube-shorts": { targetI: -14.0, targetTp: -1.0, targetLra: 7.0 },
  youtube: { targetI: -14.0, targetTp: -1.0, targetLra: 7.0 },
  shorts: { targetI: -14.0, targetTp: -1.0, targetLra: 7.0 },
  "youtube-4k": { targetI: -14.0, targetTp: -1.0, targetLra: 7.0 },
  tiktok: { targetI: -15.0, targetTp: -1.0, targetLra: 7.0 },
  reels: { targetI: -15.0, targetTp: -1.0, targetLra: 7.0 },
  instagram: { targetI: -15.0, targetTp: -1.0, targetLra: 7.0 },
  "instagram-story": { targetI: -15.0, targetTp: -1.0, targetLra: 7.0 },
  "instagram-feed": { targetI: -15.0, targetTp: -1.0, targetLra: 7.0 },
  default: { targetI: -14.0, targetTp: -1.0, targetLra: 7.0 },
});

export function resolveLoudnessTarget(platformOrPreset?: string): LoudnessTargetSpec {
  if (!platformOrPreset) return PLATFORM_LOUDNESS_TARGETS["default"]!;
  const key = platformOrPreset.toLowerCase().trim();
  // eslint-disable-next-line security/detect-object-injection
  return PLATFORM_LOUDNESS_TARGETS[key] ?? PLATFORM_LOUDNESS_TARGETS["default"]!;
}

export interface LoudnormStats {
  readonly inputI: number;
  readonly inputTp: number;
  readonly inputLra: number;
  readonly inputThresh: number;
  readonly targetOffset: number;
}

/**
 * Parses the JSON block printed by FFmpeg's `loudnorm=...:print_format=json` filter.
 */
export function parseLoudnormJson(stderr: string): LoudnormStats | null {
  const match =
    /\{[\s\S]*?"input_i"\s*:\s*"(-?[\d.]+)"[\s\S]*?"input_tp"\s*:\s*"(-?[\d.]+)"[\s\S]*?"input_lra"\s*:\s*"(-?[\d.]+)"[\s\S]*?"input_thresh"\s*:\s*"(-?[\d.]+)"[\s\S]*?"target_offset"\s*:\s*"(-?[\d.]+)"[\s\S]*?\}/.exec(
      stderr,
    );

  if (!match) {
    const block = /\{[^{}]*"input_i"[^{}]*\}/.exec(stderr);
    if (block) {
      try {
        const parsed = JSON.parse(block[0]) as Record<string, string>;
        const inputI = Number(parsed["input_i"]);
        const inputTp = Number(parsed["input_tp"]);
        const inputLra = Number(parsed["input_lra"]);
        const inputThresh = Number(parsed["input_thresh"]);
        const targetOffset = Number(parsed["target_offset"]);
        if ([inputI, inputTp, inputLra, inputThresh, targetOffset].every(Number.isFinite)) {
          return { inputI, inputTp, inputLra, inputThresh, targetOffset };
        }
      } catch {
        // continue
      }
    }
    return null;
  }

  const inputI = Number(match[1]);
  const inputTp = Number(match[2]);
  const inputLra = Number(match[3]);
  const inputThresh = Number(match[4]);
  const targetOffset = Number(match[5]);

  if ([inputI, inputTp, inputLra, inputThresh, targetOffset].every(Number.isFinite)) {
    return { inputI, inputTp, inputLra, inputThresh, targetOffset };
  }
  return null;
}

/**
 * Builds FFmpeg loudnorm filter for Pass 1 (measurement).
 */
export function buildLoudnormPass1Filter(
  target: LoudnessTargetSpec = PLATFORM_LOUDNESS_TARGETS["default"]!,
): string {
  return `loudnorm=I=${target.targetI.toFixed(1)}:tp=${target.targetTp.toFixed(1)}:LRA=${target.targetLra.toFixed(1)}:print_format=json`;
}

/**
 * Builds FFmpeg loudnorm filter for Pass 2 (linear normalization).
 * Setting `linear=true` ensures pure linear gain adjustment without dynamic compressor pumping.
 */
export function buildLoudnormPass2Filter(
  target: LoudnessTargetSpec,
  stats: LoudnormStats,
  linear = true,
): string {
  return (
    `loudnorm=I=${target.targetI.toFixed(1)}:tp=${target.targetTp.toFixed(1)}:LRA=${target.targetLra.toFixed(1)}:` +
    `measured_I=${stats.inputI.toFixed(2)}:measured_tp=${stats.inputTp.toFixed(2)}:` +
    `measured_LRA=${stats.inputLra.toFixed(2)}:measured_thresh=${stats.inputThresh.toFixed(2)}:` +
    `offset=${stats.targetOffset.toFixed(2)}:linear=${linear ? "true" : "false"}`
  );
}

/**
 * Run Pass 1 measurement on an audio file or stream.
 */
export async function measureLoudnormStats(input: {
  readonly binary: string;
  readonly source: string;
  readonly target?: LoudnessTargetSpec;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<LoudnormStats | null> {
  const target = input.target ?? PLATFORM_LOUDNESS_TARGETS["default"]!;
  const filter = buildLoudnormPass1Filter(target);
  let capturedStderr = "";
  const result = await run(
    input.binary,
    [
      ...FFMPEG_BASE_ARGS,
      "-loglevel",
      "info",
      ...inputArgs(input.source),
      "-vn",
      "-sn",
      "-dn",
      "-af",
      filter,
      "-f",
      "null",
      "-",
    ],
    {
      timeoutMs: input.timeoutMs ?? 30_000,
      onStderr: (chunk) => {
        capturedStderr += chunk;
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  ).catch(() => null);

  if (result === null || result.code !== 0) return null;
  return parseLoudnormJson(capturedStderr.length > 0 ? capturedStderr : result.stderr);
}

export interface NormalizeAudioResult {
  readonly success: boolean;
  readonly stats: LoudnormStats | null;
  readonly target: LoudnessTargetSpec;
  readonly filter: string | null;
}

/**
 * Execute full Two-Pass loudness normalization on an audio file:
 * - Pass 1: Measure loudness statistics with `loudnorm ... print_format=json`
 * - Pass 2: Apply linear gain and brickwall limiting using measured parameters
 */
export async function normalizeAudioTwoPass(input: {
  readonly binary: string;
  readonly source: string;
  readonly destination: string;
  readonly target?: LoudnessTargetSpec;
  readonly sampleRate?: number;
  readonly linear?: boolean;
  readonly audioCodec?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<NormalizeAudioResult> {
  const target = input.target ?? PLATFORM_LOUDNESS_TARGETS["default"]!;
  const stats = await measureLoudnormStats({
    binary: input.binary,
    source: input.source,
    target,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  if (stats === null) {
    return { success: false, stats: null, target, filter: null };
  }

  const pass2Filter = buildLoudnormPass2Filter(target, stats, input.linear ?? true);
  const codec = input.audioCodec ?? (input.destination.endsWith(".wav") ? "pcm_s16le" : "aac");
  const sampleRate = input.sampleRate ?? 48_000;

  const result = await run(
    input.binary,
    [
      ...FFMPEG_BASE_ARGS,
      ...inputArgs(input.source),
      "-vn",
      "-sn",
      "-dn",
      "-af",
      pass2Filter,
      "-c:a",
      codec,
      "-ar",
      String(sampleRate),
      input.destination,
    ],
    {
      timeoutMs: input.timeoutMs ?? 60_000,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    },
  ).catch(() => null);

  const success = result !== null && result.code === 0;
  return { success, stats, target, filter: pass2Filter };
}

/**
 * Verify SLA: Output integrated loudness must equal target ± 0.5 LUFS,
 * and true peak must be <= -1.0 dBTP.
 */
export function verifyLoudnessCompliance(
  measuredLufs: number,
  targetLufs: number,
  truePeakDbfs?: number | null,
  tolerance = 0.5,
): boolean {
  const lufsCompliant = Math.abs(measuredLufs - targetLufs) <= tolerance;
  const peakCompliant = truePeakDbfs === undefined || truePeakDbfs === null || truePeakDbfs <= -0.95;
  return lufsCompliant && peakCompliant;
}

