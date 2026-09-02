/**
 * The two external binaries this service cannot run without, and the version
 * floor it is tested against.
 *
 * There is no pure-JS fallback: Skia draws the captions, ffmpeg does everything
 * else — decode, cut, scale, crop, composite, encode, mux. A missing binary is a
 * boot failure with installation instructions, not a job that fails one at a
 * time in production.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const REQUIRED_TOOLS = ["ffmpeg", "ffprobe"] as const;

export type MediaTool = (typeof REQUIRED_TOOLS)[number];

/**
 * The ffmpeg major this service is developed and tested against, and the one the
 * Dockerfile installs.
 *
 * Pinned because the filter graph is the contract with ffmpeg, not just a
 * command line: `overlay`, `trim`/`concat` and `scale`/`crop` have all changed
 * defaults across majors, and `shaping=complex` on the `ass` filter — the thing
 * D35 says to verify before any Indic burn-in ships — depends on how the binary
 * was configured, not only on its version.
 */
export const EXPECTED_FFMPEG_MAJOR = 9;

/** Older majors are refused on boot rather than trusted. */
export const MINIMUM_FFMPEG_MAJOR = 6;

export interface MediaToolVersion {
  readonly tool: MediaTool;
  /** First line of `-version`, e.g. "ffmpeg version 9.0-full_build-…". */
  readonly version: string;
  /** Parsed major, or `null` when the build string does not carry one. */
  readonly major: number | null;
}

export class MediaToolsError extends Error {
  public override readonly name = "MediaToolsError";
  constructor(
    readonly code: "render/no-ffmpeg" | "render/ffmpeg-too-old",
    message: string,
  ) {
    super(message);
  }
}

/** `ffmpeg version 9.0-full_build-www.gyan.dev …` → 9. */
export function parseMajor(versionLine: string): number | null {
  const match = /version\s+n?(\d+)\./.exec(versionLine);
  if (match?.[1] === undefined) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

/** Probe one binary; resolves to its version line, or `null` when unavailable. */
export async function toolVersion(tool: MediaTool): Promise<string | null> {
  try {
    const { stdout } = await run(tool, ["-version"], { timeout: 10_000, windowsHide: true });
    return stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  } catch {
    return null;
  }
}

function missingMessage(missing: readonly MediaTool[]): string {
  return [
    `Cannot start the render service: ${missing.join(" and ")} ` +
      `${missing.length === 1 ? "is" : "are"} not on PATH.`,
    "",
    "Captions are drawn by Skia, but every other stage — decode, cut, scale,",
    "composite, encode, mux — is FFmpeg. There is no fallback.",
    "",
    `  Windows  winget install Gyan.FFmpeg     (ffmpeg ${String(EXPECTED_FFMPEG_MAJOR)}.x)`,
    "  macOS    brew install ffmpeg",
    "  Debian   sudo apt-get install -y ffmpeg",
    "  Docker   the deployed image installs it in the base layer",
    "",
    "Then reopen your shell and check: ffmpeg -version && ffprobe -version",
  ].join("\n");
}

/**
 * Boot check: every required binary present, runnable and new enough.
 *
 * @throws {MediaToolsError} naming exactly what is missing or too old.
 */
export async function assertMediaToolsAvailable(): Promise<readonly MediaToolVersion[]> {
  const results = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => {
      const version = await toolVersion(tool);
      return { tool, version, major: version === null ? null : parseMajor(version) };
    }),
  );

  const missing = results.filter((result) => result.version === null).map((result) => result.tool);
  if (missing.length > 0) throw new MediaToolsError("render/no-ffmpeg", missingMessage(missing));

  for (const result of results) {
    if (result.major !== null && result.major < MINIMUM_FFMPEG_MAJOR) {
      throw new MediaToolsError(
        "render/ffmpeg-too-old",
        `${result.tool} ${String(result.major)} is older than the supported floor ` +
          `(${String(MINIMUM_FFMPEG_MAJOR)}); the service is tested against ` +
          `${String(EXPECTED_FFMPEG_MAJOR)}.x. Found: ${result.version ?? ""}`,
      );
    }
  }

  return results.map((result) => ({
    tool: result.tool,
    version: result.version ?? "",
    major: result.major,
  }));
}
