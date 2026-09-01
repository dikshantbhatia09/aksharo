import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** External binaries this worker cannot run without. */
export const REQUIRED_TOOLS = ["ffmpeg", "ffprobe"] as const;

export type MediaTool = (typeof REQUIRED_TOOLS)[number];

export interface MediaToolVersion {
  readonly tool: MediaTool;
  /** First line of `--version` output, e.g. "ffmpeg version 7.1". */
  readonly version: string;
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
      ].join("\n"),
    );
  }
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

/**
 * Boot check: verify every required binary is present and runnable.
 *
 * @throws {MediaToolsMissingError} listing exactly which binaries are missing.
 */
export async function assertMediaToolsAvailable(): Promise<readonly MediaToolVersion[]> {
  const results = await Promise.all(
    REQUIRED_TOOLS.map(async (tool) => ({ tool, version: await toolVersion(tool) })),
  );

  const missing = results.filter((r) => r.version === null).map((r) => r.tool);
  if (missing.length > 0) throw new MediaToolsMissingError(missing);

  return results.map(({ tool, version }) => ({ tool, version: version ?? "" }));
}
