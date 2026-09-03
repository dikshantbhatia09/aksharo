import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** External binaries this worker cannot run without. */
export const REQUIRED_TOOLS = ["ffmpeg", "ffprobe"] as const;

export type MediaTool = (typeof REQUIRED_TOOLS)[number];

/**
 * The oldest ffmpeg major this worker is known to work against.
 *
 * Not a whim: the proxy chain uses `zscale`/`tonemap` for HDR, `-progress pipe:2`
 * for the heartbeat's percentage, and `ebur128=peak=true` for the loudness pass,
 * and `-reconnect_on_network_error` for reading through a presigned URL. All of
 * those exist in 6.x, so 6 is the floor and the Dockerfile installs whatever
 * Debian's archive has above it. The development machines and CI run 9.x.
 *
 * An older build is **refused at boot**, not tolerated: a worker that silently
 * produces flat HDR proxies or reports no progress is far worse than one that
 * will not start.
 */
export const MINIMUM_FFMPEG_MAJOR = 6;

export interface MediaToolVersion {
  readonly tool: MediaTool;
  /** First line of `-version` output, e.g. `ffmpeg version 9.0-full_build`. */
  readonly version: string;
  /** The leading major, or `null` when the build string does not carry one. */
  readonly major: number | null;
}

/** Thrown on boot when ffmpeg or ffprobe is missing or not executable. */
export class MediaToolsMissingError extends Error {
  public override readonly name = "MediaToolsMissingError";

  constructor(public readonly missing: readonly MediaTool[]) {
    super(
      [
        `Cannot start worker-media: ${missing.join(" and ")} ` +
          `${missing.length === 1 ? "is" : "are"} not on PATH.`,
        "",
        "This worker shells out to FFmpeg for probing, audio extraction, proxies,",
        "waveforms and thumbnails; there is no pure-JS fallback.",
        "",
        "  Windows  winget install Gyan.FFmpeg   (or: choco install ffmpeg-full)",
        "  macOS    brew install ffmpeg",
        "  Debian   sudo apt-get install -y ffmpeg",
        "  Docker   the deployed image installs ffmpeg in the base layer",
        "",
        "Then reopen your shell and check: ffmpeg -version && ffprobe -version",
        "",
        "FFMPEG_PATH and FFPROBE_PATH point at a build that is not on PATH.",
      ].join("\n"),
    );
  }
}

/** Thrown on boot when the binaries are present but too old to trust. */
export class MediaToolsTooOldError extends Error {
  public override readonly name = "MediaToolsTooOldError";

  constructor(public readonly found: readonly MediaToolVersion[]) {
    super(
      [
        `Cannot start worker-media: FFmpeg ${String(MINIMUM_FFMPEG_MAJOR)} or newer is required.`,
        "",
        ...found.map((entry) => `  ${entry.tool}: ${entry.version}`),
        "",
        "The proxy chain needs `zscale`/`tonemap` (HDR), `-progress pipe:2` (job",
        "progress) and `-reconnect_on_network_error` (reading a presigned URL).",
        "An older build starts fine and then produces flat HDR proxies and no",
        "progress, which is worse than refusing to start.",
      ].join("\n"),
    );
  }
}

/** The leading major version in an ffmpeg banner line, or `null`. */
export function parseMajor(versionLine: string): number | null {
  const match = /version\s+n?(\d+)/i.exec(versionLine);
  const major = Number(match?.[1]);
  return Number.isFinite(major) ? major : null;
}

/** Probe one binary; resolves to its version line, or `null` when unavailable. */
export async function toolVersion(tool: MediaTool, binary: string = tool): Promise<string | null> {
  try {
    const { stdout } = await run(binary, ["-version"], { timeout: 10_000, windowsHide: true });
    return stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
  } catch {
    return null;
  }
}

/**
 * Boot check: every required binary present, runnable and new enough.
 *
 * @throws {MediaToolsMissingError} listing exactly which binaries are missing.
 * @throws {MediaToolsTooOldError} when a build is older than
 *   {@link MINIMUM_FFMPEG_MAJOR}.
 */
export async function assertMediaToolsAvailable(
  paths: Readonly<Record<MediaTool, string>> = { ffmpeg: "ffmpeg", ffprobe: "ffprobe" },
): Promise<readonly MediaToolVersion[]> {
  const results = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => ({
      tool,
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      version: await toolVersion(tool, paths[tool]),
    })),
  );

  const missing = results.filter((entry) => entry.version === null).map((entry) => entry.tool);
  if (missing.length > 0) throw new MediaToolsMissingError(missing);

  const found: MediaToolVersion[] = results.map((entry) => ({
    tool: entry.tool,
    version: entry.version ?? "",
    major: parseMajor(entry.version ?? ""),
  }));

  // A build whose banner has no version number at all — a distribution's own
  // patched string — is allowed through: refusing it would break a deployment on
  // the strength of a regex, and the graphs themselves fail loudly if they must.
  if (found.some((entry) => entry.major !== null && entry.major < MINIMUM_FFMPEG_MAJOR)) {
    throw new MediaToolsTooOldError(found);
  }

  return found;
}
