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
