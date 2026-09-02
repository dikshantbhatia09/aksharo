import { spawn } from "node:child_process";

import { stderrTail, transientFailure } from "../errors.js";

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

/**
 * Running ffmpeg and ffprobe as child processes, safely.
 *
 * Every rule here exists because of a specific way this goes wrong:
 *
 * - **`spawn`, never a shell.** Arguments are an array and go to `execve`
 *   untouched. A filename with a space, a quote or a `;` in it is then just a
 *   filename (THREAT-MODEL T7): there is no shell to reinterpret it.
 * - **`-nostdin`.** ffmpeg reads the terminal for its interactive keys; in a
 *   worker there is no terminal, and without this an ffmpeg that hits a prompt
 *   sits on the lock until it expires.
 * - **stdout is a pipe with a cap, stderr is a ring buffer.** ffprobe's JSON goes
 *   to stdout and is small; ffmpeg's diagnostics go to stderr and can be
 *   megabytes on a damaged file. Only the tail is ever needed, so only the tail is
 *   kept — an unbounded string here is how a worker runs out of memory on the one
 *   input it should merely have refused.
 * - **A timeout that kills, then kills harder.** SIGTERM lets ffmpeg finish
 *   writing its container; SIGKILL after a grace period covers the case where it
 *   is wedged in a syscall.
 * - **Nothing from stderr is returned unredacted.** The source is a presigned
 *   URL and ffmpeg prints the URL it could not open.
 */

/** How long a killed process gets to exit on SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 5_000;

/** Stderr kept in memory, in bytes. Only the tail is ever read. */
const STDERR_LIMIT = 256 * 1024;

/** Stdout kept in memory, in bytes. ffprobe JSON for a long file is well under this. */
const STDOUT_LIMIT = 16 * 1024 * 1024;

export interface RunOptions {
  readonly timeoutMs: number;
  /** Called with each stderr chunk, for progress parsing. */
  readonly onStderr?: (chunk: string) => void;
  /** An abort that kills the child — a worker shutting down mid-encode. */
  readonly signal?: AbortSignal;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  /** The tail only, already redacted. */
  readonly stderr: string;
}

/**
 * Run a binary to completion.
 *
 * Resolves for **any** exit code — a non-zero exit is information the caller
 * interprets (ffprobe exits 1 on a file it cannot read, which is a `media/*`
 * answer, not a crash). Rejects only when the process could not be started, was
 * killed by the timeout, or was aborted.
 */
export async function run(
  binary: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(binary, [...args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      reject(transientFailure("media/tool_spawn", `could not start ${binary}`, { cause: error }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedBy: "timeout" | "abort" | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };

    const kill = (why: "timeout" | "abort"): void => {
      killedBy = why;
      child.kill("SIGTERM");
      // A process wedged in a syscall ignores SIGTERM; the lock is finite and so
      // is our patience.
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };

    const timer = setTimeout(() => kill("timeout"), options.timeoutMs);
    timer.unref();

    const onAbort = (): void => kill("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < STDOUT_LIMIT) stdout += chunk;
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      options.onStderr?.(chunk);
      stderr += chunk;
      // A ring buffer, not a truncation: the tail is the part that says why.
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
    });

    child.on("error", (error) => {
      finish(() =>
        reject(transientFailure("media/tool_spawn", `${binary} failed to run`, { cause: error })),
      );
    });

    child.on("close", (code, signal) => {
      const tail = stderrTail(stderr);
      if (killedBy !== null) {
        finish(() =>
          reject(
            transientFailure(
              killedBy === "timeout" ? "media/tool_timeout" : "media/cancelled",
              killedBy === "timeout"
                ? `${binary} exceeded ${String(options.timeoutMs)} ms and was killed`
                : `${binary} was cancelled`,
              { detail: tail },
            ),
          ),
        );
        return;
      }
      if (code === null) {
        finish(() =>
          reject(
            transientFailure("media/tool_signal", `${binary} was killed by ${signal ?? "a signal"}`, {
              detail: tail,
            }),
          ),
        );
        return;
      }
      finish(() => resolve({ code, stdout, stderr: tail }));
    });
  });
}

/** Arguments every ffmpeg invocation starts with. */
export const FFMPEG_BASE_ARGS = [
  "-nostdin",
  "-hide_banner",
  // Deterministic errors instead of a prompt when an output file exists: a retry
  // of the same job writes over its own half-finished scratch file.
  "-y",
] as const;

/**
 * Reconnect options for reading over HTTPS.
 *
 * The source is a presigned URL and ffmpeg re-opens it for every seek, so a
 * single dropped connection two thirds of the way through a sixty-minute encode
 * would otherwise throw the whole job away. These make ffmpeg retry the range
 * request instead.
 */
export const HTTP_INPUT_ARGS = [
  "-reconnect",
  "1",
  "-reconnect_streamed",
  "1",
  "-reconnect_on_network_error",
  "1",
  "-reconnect_delay_max",
  "30",
] as const;

/** The input arguments for a source, with HTTP resilience when it is a URL. */
export function inputArgs(source: string): string[] {
  return source.startsWith("http://") || source.startsWith("https://")
    ? [...HTTP_INPUT_ARGS, "-i", source]
    : ["-i", source];
}
