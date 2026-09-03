/**
 * The rasteriser pool: Skia on other threads, so it overlaps with ffmpeg.
 *
 * **Why this exists.** A20 measured a 1080p render at 1.05× realtime and found
 * the reason: rasterising a frame is synchronous and blocks Node's only thread,
 * and the OS pipe holds 64 KB — a hundred and twenty-eighth of a frame — so
 * ffmpeg starved while Skia drew and Skia idled while ffmpeg encoded. The two
 * halves were each about half the wall clock and ran one after the other.
 * Putting the rasteriser on other threads lets them run at the same time.
 *
 * **What crosses the boundary, and what does not.** A finished `DrawCommand[]`
 * goes out — about 12 KB for a caption frame — and a slot number comes back.
 * Pixels never move: the main thread allocates one `SharedArrayBuffer` per slot
 * and hands them to every worker at construction, and a worker draws into a view
 * of the slot it was given. An 8.3 MB structured clone per frame would cost more
 * than the parallelism buys; A20 measured exactly that mistake when it tried a
 * run-ahead buffer on the pipe.
 *
 * **What stays on the main thread.** Layout, the frame-diff hash and the cache
 * decision. That is deliberate: the cache is exact because it compares the list
 * `renderFrame` produced, and moving it into the workers would mean every worker
 * knowing what the previous frame looked like. Only the frames that actually
 * change are dispatched — two thirds of a typical render never reach a worker.
 *
 * **Memory is bounded by the slot count, not the frame count.**
 * `slots × width × height × 4`, allocated once: eight slots at 1080p is 66 MB,
 * and at 4K it is 265 MB, which is why the slot count is small and stated rather
 * than inferred.
 */

import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import type { DrawCommand, FontResource } from "@montaj/render-core";

/**
 * The ceiling on workers.
 *
 * Four, because past that the render stops being the bottleneck: the stage split
 * in `BENCHMARK.md` has ffmpeg taking over at about three, and every extra
 * worker is a core x264 does not get.
 */
export const MAX_RASTER_WORKERS = 4;

/** `min(cores − 1, 4)`: one core is left for the thread feeding ffmpeg. */
export function defaultPoolSize(cores: number = cpus().length): number {
  return Math.max(1, Math.min(MAX_RASTER_WORKERS, cores - 1));
}

/** Slots per worker: one being drawn, one being written down the pipe. */
export const SLOTS_PER_WORKER = 2;

export class RasterPoolError extends Error {
  public override readonly name = "RasterPoolError";
  constructor(
    readonly code: "render/worker-unavailable" | "render/worker-failed",
    message: string,
  ) {
    super(message);
  }
}

/** A rasterised frame, and the slot it lives in. */
export interface PoolFrame {
  readonly slot: number;
  /** A view of the slot's shared memory. Valid until it is released. */
  readonly bytes: Uint8Array;
}

export interface RasterPool {
  readonly size: number;
  readonly slots: number;
  /** How many more frames can be dispatched before a slot has to come back. */
  readonly free: number;
  /** Draws `commands` into a free slot. Waits when every slot is in use. */
  render(commands: readonly DrawCommand[]): Promise<PoolFrame>;
  /** Hands a slot back. Every `render` result must be released exactly once. */
  release(frame: PoolFrame): void;
  terminate(): Promise<void>;
}

export interface RasterPoolOptions {
  readonly width: number;
  readonly height: number;
  readonly fonts: readonly FontResource[];
  /** Assets an `image` command may name — the watermark, today. */
  readonly images?: readonly { readonly assetId: string; readonly bytes: Uint8Array }[];
  readonly size?: number;
  readonly slots?: number;
  /** Overrides the resolved worker entry point; a test points it at a stub. */
  readonly workerPath?: string;
  /**
   * Called once per distinct missing asset a worker reported. Without it a font
   * or an image that never reached the workers would cost a caption silently —
   * the inline backend surfaces the same thing through `batch.diagnostics`.
   */
  readonly onMissing?: (resource: string) => void;
}

/**
 * The worker entry, resolved the same way from source and from `dist`.
 *
 * `src/render/pool.ts` and `dist/render/pool.js` are both two directories below
 * the package root, so one relative path finds `workers/raster-worker.mjs` from
 * either. That file is plain JavaScript because `worker_threads` loads it with
 * Node's own loader, not with vitest's or tsx's.
 */
export function resolveWorkerPath(): string {
  return join(__dirname, "..", "..", "workers", "raster-worker.mjs");
}

interface Pending {
  readonly resolve: (frame: PoolFrame) => void;
  readonly reject: (error: Error) => void;
  readonly slot: number;
}

interface PoolWorker {
  readonly worker: Worker;
  busy: boolean;
}

interface WorkerMessage {
  readonly type: string;
  readonly id?: number;
  readonly slot?: number;
  readonly message?: string;
  readonly missing?: readonly string[];
}

/**
 * Starts the pool. Resolves once every worker has its fonts, its shaper and its
 * surfaces — a worker that booted lazily would take its first frame's latency
 * out of the render's wall clock instead of out of its startup.
 *
 * @throws {RasterPoolError} when the worker entry is missing or a worker cannot
 * boot. The caller falls back to rasterising inline.
 */
export async function createRasterPool(options: RasterPoolOptions): Promise<RasterPool> {
  const size = Math.max(1, options.size ?? defaultPoolSize());
  const slotCount = Math.max(size, options.slots ?? size * SLOTS_PER_WORKER);
  /**
   * Slots currently being drawn. The invariant this enforces — one frame per
   * slot at a time — is the difference between a correct render and a picture
   * that is subtly wrong in ways only a pixel comparison finds, so it is
   * checked rather than assumed. It costs one `Set` operation per frame.
   */
  const inFlight = new Set<number>();
  const workerPath = options.workerPath ?? resolveWorkerPath();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (!existsSync(workerPath)) {
    throw new RasterPoolError(
      "render/worker-unavailable",
      `the rasteriser worker is not at ${workerPath}`,
    );
  }

  const frameBytes = options.width * options.height * 4;
  const shared = Array.from({ length: slotCount }, () => new SharedArrayBuffer(frameBytes));
  const views = shared.map((buffer) => new Uint8Array(buffer));
  const freeSlots: number[] = shared.map((_buffer, index) => index);
  const waitingForSlot: ((slot: number) => void)[] = [];

  // Fonts are cloned once per worker at construction, never once per frame.
  const fontPayload = options.fonts.map((font) => ({
    id: font.id,
    family: font.family,
    weight: font.weight,
    italic: font.italic,
    data: font.data,
    ...(font.scripts === undefined ? {} : { scripts: [...font.scripts] }),
  }));

  const imagePayload = (options.images ?? []).map((image) => ({
    assetId: image.assetId,
    bytes: image.bytes,
  }));

  const reportedMissing = new Set<string>();
  const pending = new Map<number, Pending>();
  const workers: PoolWorker[] = [];
  const idleWorkers: PoolWorker[] = [];
  const waitingForWorker: ((worker: PoolWorker) => void)[] = [];
  let nextId = 0;
  let terminated = false;

  /**
   * Reserving a slot is **synchronous**, and that is the whole correctness story
   * of the dispatcher above this: `free` has to be true at the instant the
   * caller reads it. An `async` reservation only pops the slot on the next
   * microtask, so a synchronous dispatch loop reads a stale count, hands the
   * same slot to several frames, and the encoder gets the wrong picture — which
   * is exactly what happened before this was a plain function.
   */
  const takeSlotNow = (): number | undefined => freeSlots.pop();

  const giveSlot = (slot: number): void => {
    const waiter = waitingForSlot.shift();
    if (waiter === undefined) freeSlots.push(slot);
    else waiter(slot);
  };

  const giveWorker = (entry: PoolWorker): void => {
    const waiter = waitingForWorker.shift();
    if (waiter === undefined) {
      entry.busy = false;
      idleWorkers.push(entry);
    } else {
      waiter(entry);
    }
  };

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const start = async (): Promise<void> => {
    const worker = new Worker(workerPath, {
      workerData: {
        width: options.width,
        height: options.height,
        fonts: fontPayload,
        images: imagePayload,
        slots: shared,
      },
    });
    const entry: PoolWorker = { worker, busy: true };
    workers.push(entry);

    await new Promise<void>((resolve, reject) => {
      const onBoot = (message: WorkerMessage): void => {
        if (message.type === "ready") {
          worker.off("message", onBoot);
          resolve();
        } else if (message.type === "boot-failed") {
          worker.off("message", onBoot);
          reject(
            new RasterPoolError(
              "render/worker-failed",
              `a rasteriser worker could not start: ${message.message ?? "unknown"}`,
            ),
          );
        }
      };
      worker.on("message", onBoot);
      worker.once("error", (error: Error) => {
        reject(
          new RasterPoolError(
            "render/worker-failed",
            `a rasteriser worker could not start: ${error.message}`,
          ),
        );
      });
    });

    worker.on("message", (message: WorkerMessage) => {
      if (message.type !== "done" && message.type !== "failed") return;
      const id = message.id ?? -1;
      const waiting = pending.get(id);
      pending.delete(id);
      giveWorker(entry);
      if (waiting === undefined) return;
      if (message.type === "done") {
        for (const resource of message.missing ?? []) {
          if (reportedMissing.has(resource)) continue;
          reportedMissing.add(resource);
          options.onMissing?.(resource);
        }
        waiting.resolve({ slot: waiting.slot, bytes: views[waiting.slot] as Uint8Array });
      } else {
        giveSlot(waiting.slot);
        waiting.reject(
          new RasterPoolError(
            "render/worker-failed",
            `a frame could not be rasterised: ${message.message ?? "unknown"}`,
          ),
        );
      }
    });
    worker.on("error", (error: Error) => {
      failAll(new RasterPoolError("render/worker-failed", error.message));
    });
    giveWorker(entry);
  };

  try {
    await Promise.all(Array.from({ length: size }, () => start()));
  } catch (error) {
    await Promise.all(workers.map((entry) => entry.worker.terminate()));
    throw error;
  }

  /** Posts one frame to a worker, taking the next idle one or queueing for it. */
  const dispatch = (slot: number, commands: readonly DrawCommand[]): Promise<PoolFrame> =>
    new Promise<PoolFrame>((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      if (inFlight.has(slot)) {
        reject(
          new RasterPoolError(
            "render/worker-failed",
            `slot ${String(slot)} was dispatched while it was still being drawn`,
          ),
        );
        return;
      }
      inFlight.add(slot);
      pending.set(id, { resolve, reject, slot });
      const message = { type: "render", id, slot, commands };
      const idle = idleWorkers.pop();
      if (idle !== undefined) {
        idle.busy = true;
        idle.worker.postMessage(message);
        return;
      }
      waitingForWorker.push((worker) => {
        worker.worker.postMessage(message);
      });
    });

  return {
    size,
    slots: slotCount,
    get free() {
      return freeSlots.length;
    },

    render(commands) {
      if (terminated) {
        return Promise.reject(
          new RasterPoolError("render/worker-failed", "the rasteriser pool is closed"),
        );
      }
      const slot = takeSlotNow();
      if (slot !== undefined) return dispatch(slot, commands);
      return new Promise<PoolFrame>((resolve, reject) => {
        waitingForSlot.push((waited) => {
          dispatch(waited, commands).then(resolve, reject);
        });
      });
    },

    release(frame) {
      inFlight.delete(frame.slot);
      giveSlot(frame.slot);
    },

    async terminate() {
      terminated = true;
      failAll(new RasterPoolError("render/worker-failed", "the rasteriser pool was closed"));
      await Promise.all(workers.map((entry) => entry.worker.terminate()));
    },
  };
}
