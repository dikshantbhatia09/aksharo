/**
 * Automated Platform Loudness Normalization Engine for apps/render.
 *
 * Implements ITU-R BS.1770-4 / EBU R128 Two-Pass Loudness Normalization:
 * - Pass 1: Measures audio integrated loudness and true peak with `loudnorm ... print_format=json`
 * - Pass 2: Applies exact target loudness using measured statistics with `linear=true`
 *
 * Platform target specs:
 * - YouTube / YouTube Shorts: -14.0 LUFS, -1.0 dBTP, LRA 7.0
 * - TikTok & Instagram Reels: -15.0 LUFS, -1.0 dBTP, LRA 7.0
 * - Default: -14.0 LUFS, -1.0 dBTP, LRA 7.0
 */

import { spawn } from "node:child_process";

import type { RenderManifest } from "@montaj/render-manifest";
import type { TimeQuery, TimeSpan } from "@montaj/timemap";

import {
  buildAudioMixPlan,
  type MusicMixCue,
  type SfxMixCue,
  type SpeechRange,
} from "./audio-mix.js";

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

export function buildLoudnormPass1Filter(
  target: LoudnessTargetSpec = PLATFORM_LOUDNESS_TARGETS["default"]!,
): string {
  return `loudnorm=I=${target.targetI.toFixed(1)}:tp=${target.targetTp.toFixed(1)}:LRA=${target.targetLra.toFixed(1)}:print_format=json`;
}

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

export interface AudioPass1Input {
  readonly manifest: RenderManifest;
  readonly sourcePath: string | null;
  readonly cleanAudioPath?: string | null;
  readonly sourceHasAudio: boolean;
  readonly spans: readonly TimeSpan[];
  readonly outputDurationMs: number;
  readonly target: LoudnessTargetSpec;
  readonly sfxCues?: readonly SfxMixCue[];
  readonly musicCues?: readonly MusicMixCue[];
  readonly speechRanges?: readonly SpeechRange[];
  readonly timemap?: TimeQuery | null;
}

export interface AudioPass1Plan {
  readonly args: readonly string[];
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

/**
 * Builds the audio-only FFmpeg argument list for Pass 1 loudness measurement.
 * Skips video frames and Skia drawing completely, measuring only the composited audio bus.
 */
export function buildAudioPass1Plan(input: AudioPass1Input): AudioPass1Plan | null {
  const { manifest } = input;
  const wantsAudio = manifest.audio.strategy !== "none";
  const replacing = manifest.audio.strategy === "replace";
  const sfxCues = input.sfxCues ?? [];
  const musicCues = input.musicCues ?? [];
  const hasDialogue = replacing
    ? input.cleanAudioPath !== null && input.cleanAudioPath !== undefined
    : input.sourceHasAudio && input.sourcePath !== null;
  const hasAudio = wantsAudio && (hasDialogue || sfxCues.length > 0 || musicCues.length > 0);

  if (!hasAudio) return null;

  const args: string[] = ["-nostdin", "-hide_banner", "-loglevel", "info"];
  const filters: string[] = [];
  let nextInputIndex = 0;
  let dialogueLabel: string | null = null;

  if (replacing) {
    args.push("-i", input.cleanAudioPath!);
    dialogueLabel = "0:a";
    nextInputIndex = 1;
  } else if (hasDialogue && input.sourcePath !== null) {
    args.push("-i", input.sourcePath);
    nextInputIndex = 1;

    const bearing = input.spans.filter((span) => span.outputEnd > span.outputStart);
    const unedited =
      bearing.length <= 1 &&
      bearing.every((span) => span.kind === "retained" && span.factor === 1);

    if (unedited) {
      dialogueLabel = "0:a";
    } else {
      const audioLabels: string[] = [];
      for (const [index, span] of bearing.entries()) {
        const a = `a${String(index)}`;
        if (span.kind === "hold") {
          const holdMs = span.outputEnd - span.outputStart;
          filters.push(
            `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(holdMs)},asetpts=PTS-STARTPTS[${a}]`,
          );
        } else {
          const tempo = span.factor === 1 ? "" : `,atempo=${String(span.factor)}`;
          filters.push(
            `[0:a]atrim=start=${seconds(span.sourceStart)}:end=${seconds(span.sourceEnd)},asetpts=PTS-STARTPTS${tempo}[${a}]`,
          );
        }
        audioLabels.push(`[${a}]`);
      }
      filters.push(`${audioLabels.join("")}concat=n=${String(audioLabels.length)}:v=0:a=1[cuta]`);
      dialogueLabel = "cuta";
    }
  }

  // Mix cues if any
  if (sfxCues.length > 0 || musicCues.length > 0) {
    const mixPlan = buildAudioMixPlan({
      dialogueLabel,
      sfxCues,
      musicCues,
      timemap: input.timemap ?? null,
      speechRanges: input.speechRanges ?? [],
      outputDurationMs: input.outputDurationMs,
      nextInputIndex,
      sampleRate: 48_000,
    });
    if (mixPlan !== null) {
      args.push(...mixPlan.extraInputArgs);
      filters.push(...mixPlan.filters);
      dialogueLabel = mixPlan.outLabel;
    }
  }

  const pass1Filter = buildLoudnormPass1Filter(input.target);

  if (filters.length === 0) {
    // Unedited single input with no cues
    args.push("-af", pass1Filter, "-map", dialogueLabel ?? "0:a");
  } else {
    const inRef = dialogueLabel?.includes(":") ? dialogueLabel : `[${dialogueLabel}]`;
    filters.push(`${inRef}${pass1Filter}[loudout]`);
    args.push("-filter_complex", filters.join(";"), "-map", "[loudout]");
  }

  args.push("-vn", "-sn", "-dn", "-f", "null", "-");
  return { args };
}

/**
 * Executes Pass 1 measurement with ffmpeg on the audio source and returns measured stats.
 */
export async function measureAudioLoudnormPass1(options: {
  readonly plan: AudioPass1Plan;
  readonly ffmpegPath?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<LoudnormStats | null> {
  const ffmpeg = options.ffmpegPath ?? "ffmpeg";

  return new Promise<LoudnormStats | null>((resolve) => {
    let capturedStderr = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(ffmpeg, [...options.plan.args], {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, options.timeoutMs ?? 30_000);

    const onAbort = (): void => {
      child.kill("SIGKILL");
      resolve(null);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      capturedStderr += chunk;
    });

    child.on("error", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(null);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (code !== 0) {
        resolve(null);
        return;
      }
      resolve(parseLoudnormJson(capturedStderr));
    });
  });
}
