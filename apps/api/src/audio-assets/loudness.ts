import { spawn } from "node:child_process";

/**
 * Integrated loudness/peak measurement for pack ingestion (D04a).
 *
 * `apps/worker-media/src/ffmpeg/loudness.ts` already runs the identical
 * `ebur128` pass for media probing, but it lives in a separate app
 * (`@montaj/worker-media`) that nothing outside it imports today — apps do
 * not depend on one another in this monorepo, only on `packages/*`. Rather
 * than promote that module to a shared package for one caller, this is a
 * small, self-contained twin scoped to what ingestion needs (no silence
 * detection): same filter, same parsing strategy. If a second app ever needs
 * it, that is the moment to extract `packages/audio-loudness`.
 */
export interface IntegratedLoudness {
  readonly integratedLufs: number | null;
  readonly truePeakDb: number | null;
  readonly durationMs: number | null;
}

export const EMPTY_LOUDNESS: IntegratedLoudness = Object.freeze({
  integratedLufs: null,
  truePeakDb: null,
  durationMs: null,
});

function matchNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text);
  const captured = match?.[1];
  if (captured === undefined) return null;
  const value = captured === "-inf" ? Number.NEGATIVE_INFINITY : Number.parseFloat(captured);
  return Number.isFinite(value) ? value : null;
}

function matchDurationMs(text: string): number | null {
  // ffmpeg prints `Duration: HH:MM:SS.ss` on stderr for a probed input.
  // eslint-disable-next-line security/detect-unsafe-regex -- bounded digit-count groups (\d+ once, \d{2} fixed-width, one optional \.\d+ tail), no nested/overlapping quantifiers to backtrack on -- reviewed for D04a
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(text);
  if (match === null) return null;
  const [, h, m, s] = match;
  if (h === undefined || m === undefined || s === undefined) return null;
  const ms = (Number(h) * 3600 + Number(m) * 60 + Number.parseFloat(s)) * 1000;
  return Number.isFinite(ms) ? Math.round(ms) : null;
}

export function parseLoudness(stderr: string): IntegratedLoudness {
  return {
    integratedLufs: matchNumber(stderr, /\bI:\s*(-?[\d.]+|-inf)\s*LUFS/),
    truePeakDb: matchNumber(stderr, /\bPeak:\s*(-?[\d.]+|-inf)\s*dBFS/),
    durationMs: matchDurationMs(stderr),
  };
}

/**
 * Runs `ffmpeg`'s `ebur128` filter over one local WAV file and returns the
 * integrated loudness (LUFS), true peak (dBFS) and duration (ms). Never
 * throws: a file ffmpeg cannot decode comes back as {@link EMPTY_LOUDNESS},
 * the same "measurement is advisory, ingestion is not" stance
 * `worker-media`'s probe takes, so a malformed fixture cue fails ingestion
 * with a clear "no loudness measured" row rather than crashing the CLI.
 */
export async function measureIntegratedLoudness(input: {
  readonly ffmpegBinary: string;
  readonly filePath: string;
  readonly timeoutMs?: number;
}): Promise<IntegratedLoudness> {
  const timeoutMs = input.timeoutMs ?? 30_000;

  return new Promise((resolve) => {
    const child = spawn(
      input.ffmpegBinary,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "info",
        "-i",
        input.filePath,
        "-map",
        "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-af",
        "ebur128=peak=true",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(EMPTY_LOUDNESS);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseLoudness(stderr));
    });
  });
}
