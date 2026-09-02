/**
 * Running ffmpeg with the overlay frames on its stdin.
 *
 * The loop is deliberately dull: ask the frame source for frame `n`, write it,
 * and if the pipe says it is full, wait for `drain` before asking for `n+1`.
 * That single `await` is the whole back-pressure story — the renderer runs
 * exactly as fast as the encoder drinks, so a 4K render uses one frame buffer
 * rather than filling memory with frames the encoder has not reached.
 *
 * Progress comes from **frames written**, not from parsing ffmpeg's output.
 * stdin is already the rawvideo pipe and stderr already carries the log, so
 * `-progress` would need a third channel for a number this side already knows;
 * and because writes block on the encoder, frames-written tracks the encoder
 * anyway.
 *
 * **Why there is no run-ahead buffer.** Rasterising a frame is synchronous and
 * blocks Node's only thread, so it is tempting to queue several finished frames
 * and let ffmpeg drink from the buffer while Skia draws the next one. That was
 * measured and it is *slower*: the batch hands back one reused buffer, so a
 * queued frame has to be copied, and 8.3 MB of memcpy per 1080p frame costs more
 * than the overlap buys (0.82× realtime with a four-frame run-ahead against
 * 0.95× without). Real overlap needs the rasteriser off this thread, which is a
 * worker-thread change and is written up in `BENCHMARK.md`, not a buffer size.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";

import type { Writable } from "node:stream";

export class EncodeError extends Error {
  public override readonly name = "EncodeError";
  constructor(
    readonly code: "render/ffmpeg-failed" | "render/ffmpeg-spawn-failed",
    message: string,
    readonly exitCode: number | null = null,
    /** The tail of ffmpeg's stderr, which is where the real reason is. */
    readonly stderrTail: string = "",
  ) {
    super(message);
  }
}

/** Produces the RGBA bytes for output frame `index`. */
export type FrameSource = (index: number) => Uint8Array;

export interface EncodeOptions {
  readonly args: readonly string[];
  readonly frames: number;
  readonly frame: FrameSource;
  readonly ffmpegPath?: string;
  /** Called with 0–1 as frames go down the pipe; throttled by the caller. */
  readonly onProgress?: (fraction: number, frameIndex: number) => void;
  /** How many stderr characters to keep for the error message. */
  readonly stderrTailBytes?: number;
  /** Aborts the render; the process is killed and the promise rejects. */
  readonly signal?: AbortSignal;
}

export interface EncodeResult {
  readonly framesWritten: number;
  readonly stderr: string;
  readonly wallClockMs: number;
}

/**
 * Writes one buffer, waiting for `drain` only when the pipe actually filled.
 *
 * `write` returning false does not mean the write failed — it means the internal
 * buffer is over its high-water mark and the caller should stop. Ignoring it is
 * how a render ends up holding every frame it has produced; honouring it is also
 * what lets the caller keep reusing one frame buffer, because the write has been
 * consumed by the time the next frame is drawn.
 */
async function writeFrame(stream: Writable, bytes: Uint8Array): Promise<void> {
  if (!stream.write(bytes)) await once(stream, "drain");
}

/** Spawns ffmpeg, feeds it every frame, and resolves when it exits cleanly. */
export async function runEncode(options: EncodeOptions): Promise<EncodeResult> {
  const startedAt = Date.now();
  const child = spawn(options.ffmpegPath ?? "ffmpeg", [...options.args], {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });

  const tailLimit = options.stderrTailBytes ?? 8_000;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-tailLimit);
  });

  const exited = new Promise<number | null>((resolve, reject) => {
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
    child.once("close", (code) => {
      resolve(code);
    });
  });

  const abort = (): void => {
    child.kill("SIGKILL");
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  let framesWritten = 0;
  try {
    // A broken pipe means ffmpeg died; the exit code and stderr say why, so the
    // EPIPE itself is noise and is swallowed here rather than raced with `close`.
    child.stdin.on("error", () => undefined);

    for (let index = 0; index < options.frames; index += 1) {
      if (options.signal?.aborted === true) break;
      if (child.stdin.destroyed || child.stdin.writableEnded) break;
      await writeFrame(child.stdin, options.frame(index));
      framesWritten += 1;
      options.onProgress?.(framesWritten / options.frames, index);
    }
    child.stdin.end();
  } catch (error) {
    child.kill("SIGKILL");
    await exited.catch(() => null);
    throw error instanceof EncodeError
      ? error
      : new EncodeError(
          "render/ffmpeg-failed",
          `the frame pipe failed: ${error instanceof Error ? error.message : String(error)}`,
          null,
          stderr,
        );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }

  const exitCode = await exited;
  if (exitCode !== 0) {
    throw new EncodeError(
      "render/ffmpeg-failed",
      `ffmpeg exited with ${exitCode === null ? "a signal" : `code ${String(exitCode)}`}`,
      exitCode,
      stderr,
    );
  }

  return { framesWritten, stderr, wallClockMs: Date.now() - startedAt };
}
