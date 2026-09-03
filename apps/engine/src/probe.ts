import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import type { ProbeResponse } from "@montaj/engine-client";

/**
 * Real `/probe` (brief C04b §2): shells out to the manifest's ffprobe binary
 * (`bin/ffprobe`, sibling of the manifest's `bin/ffmpeg` entry — ffprobe ships
 * alongside ffmpeg in every distribution this engine downloads) rather than
 * a native binding, matching this app's "no native compilation" rule
 * (`apps/engine/src/manifest.ts`'s doc comment).
 *
 * Not wired into a live `EngineBackend` today — only `FakeBackend` is
 * constructed (`apps/engine/src/main.ts`, "only FakeBackend is wired up") —
 * this module exists for C03b's real backend to call unchanged, exercised
 * here against an injected `execFile` so the test suite needs no real
 * ffprobe binary on disk (brief "Reality": never download one into this
 * sandbox).
 */

export type ExecFile = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFile = promisify(execFileCb) as unknown as ExecFile;

/** `ffprobe`'s installed path: same directory as the manifest's ffmpeg entry, platform-suffixed. */
export function ffprobePathFromFfmpegPath(ffmpegPath: string, platform: NodeJS.Platform): string {
  const suffix = platform === "win32" ? ".exe" : "";
  const withoutExt = ffmpegPath.replace(/(\.exe)?$/i, "");
  return withoutExt.replace(/ffmpeg$/i, `ffprobe${suffix}`);
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
  color_transfer?: string;
  color_primaries?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);
const HDR_PRIMARIES = new Set(["bt2020"]);

/** Parses ffprobe's `-print_format json -show_format -show_streams` output into `ProbeResponse`'s fields. */
export function parseFfprobeOutput(
  raw: string,
): Omit<ProbeResponse, "requestId" | "engineVersions" | "backend"> {
  const parsed = JSON.parse(raw) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");

  const durationS =
    parsed.format?.duration === undefined ? undefined : Number(parsed.format.duration);
  const fps = parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate);
  const hdr =
    (video?.color_transfer !== undefined && HDR_TRANSFERS.has(video.color_transfer)) ||
    (video?.color_primaries !== undefined && HDR_PRIMARIES.has(video.color_primaries));

  return {
    durationMs:
      durationS === undefined || Number.isNaN(durationS) ? null : Math.round(durationS * 1000),
    fps: fps ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    audioChannels: audio?.channels ?? null,
    audioSampleRateHz: audio?.sample_rate === undefined ? null : Number(audio.sample_rate),
    hdr,
  };
}

function parseFrameRate(rate: string | undefined): number | undefined {
  if (rate === undefined) return undefined;
  const [num, den] = rate.split("/").map(Number);
  if (num === undefined || Number.isNaN(num)) return undefined;
  if (den === undefined || den === 0) return num;
  return Number((num / den).toFixed(3));
}

/** Probes a media file via ffprobe, returning the fields `/probe` reports. */
export async function probeViaFfprobe(
  filePath: string,
  ffprobePath: string,
  execFile: ExecFile = defaultExecFile,
): Promise<Omit<ProbeResponse, "requestId" | "engineVersions" | "backend">> {
  const { stdout } = await execFile(ffprobePath, [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return parseFfprobeOutput(stdout);
}
