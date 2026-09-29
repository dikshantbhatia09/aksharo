/**
 * One ffmpeg run with nothing on its stdin: a compilation's pieces and its
 * join (2026-10-03). The render's own `runEncode` feeds frames through a pipe;
 * these runs read files, so all this adds is the kill on abort or timeout and
 * the tail of stderr, which is where ffmpeg says what went wrong.
 */

import { spawn } from "node:child_process";

import { EncodeError } from "../ffmpeg/encode.js";

export interface RunFfmpegOptions {
  readonly ffmpegPath?: string;
  readonly signal?: AbortSignal;
  /** Killed past this; a piece is seconds of video, so minutes means stuck. */
  readonly timeoutMs?: number;
}

const STDERR_TAIL = 8_000;

export async function runFfmpeg(
  args: readonly string[],
  options: RunFfmpegOptions = {},
): Promise<void> {
  if (options.signal?.aborted === true) {
    throw new EncodeError("render/ffmpeg-failed", "the compilation was stopped");
  }
  const child = spawn(options.ffmpegPath ?? "ffmpeg", [...args], {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });

  let reason: string | undefined;
  const kill = (why: string): void => {
    reason ??= why;
    child.kill("SIGKILL");
  };
  const onAbort = (): void => {
    kill("the compilation was stopped");
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          kill(`ffmpeg ran past ${String(options.timeoutMs)} ms`);
        }, options.timeoutMs);

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (error: Error) => {
        reject(
          new EncodeError(
            "render/ffmpeg-spawn-failed",
            `could not start ffmpeg: ${error.message}`,
            null,
            stderr,
          ),
        );
      });
      child.once("close", (exit) => {
        resolve(exit);
      });
    });
    if (reason !== undefined) {
      throw new EncodeError("render/ffmpeg-failed", reason, code, stderr);
    }
    if (code !== 0) {
      throw new EncodeError(
        "render/ffmpeg-failed",
        `ffmpeg exited with ${code === null ? "a signal" : `code ${String(code)}`}: ${lastLine(stderr)}`,
        code,
        stderr,
      );
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (timer !== undefined) clearTimeout(timer);
  }
}

function lastLine(text: string): string {
  const lines = text.trim().split(/\r?\n/u);
  return (lines.at(-1) ?? "").slice(0, 300);
}
