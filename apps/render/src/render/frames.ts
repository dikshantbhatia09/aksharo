/**
 * The frame loop: output instant → `DrawCommand[]` → RGBA, with a cache.
 *
 * **The cache is the point.** A caption is on screen for two or three seconds
 * and animates for about three hundred milliseconds of that; at 30 fps the other
 * sixty-odd frames of the segment are pixel-identical, and between segments the
 * frame is empty. Rasterising them is the single biggest avoidable cost in a
 * render, and a 1080×1920 frame is 8.3 MB, so it is also the biggest avoidable
 * allocation.
 *
 * The key is `hashCommands(commands)` — the same canonical hash A16 uses for its
 * goldens — taken over the list `renderFrame` produced, **before** it is
 * outlined. Outlining is a pure function of that list, so two frames with the
 * same hash produce the same outlines and therefore the same pixels, and two
 * frames with different pixels cannot share a hash: the cache is exact rather
 * than heuristic. Hashing before outlining also means a cached frame never pays
 * for the outlining at all, and the hash runs over glyph ids rather than over
 * the far longer path strings they expand into.
 *
 * Only the previous frame is kept. Caption changes are monotonic in time, so a
 * frame is either the same as the one before it or new; an LRU would add memory
 * and hit almost never.
 *
 * There are two sources here and they share every decision above:
 *
 * - {@link createFrameSource} rasterises inline, on this thread. It is the
 *   fallback and the one every unit test drives.
 * - {@link createPooledFrameSource} sends the changed frames to a
 *   {@link RasterPool} and runs ahead of the consumer, so Skia and ffmpeg work
 *   at the same time. It is what a real render uses, and it is worth roughly
 *   2× at 1080p (`BENCHMARK.md`).
 */

import type { StyleDoc } from "@montaj/caption-styles";
import {
  hashCommands,
  renderFrame,
  type DrawCommand,
  type EdgProjection,
  type FontRegistry,
  type RenderFrameOptions,
  type Shaper,
} from "@montaj/render-core";
import type { FrameBatch, SkiaNodeBackend } from "@montaj/render-skia-node";
import type { TimeQuery } from "@montaj/timemap";

import type { PoolFrame, RasterPool } from "./pool.js";

/** What both sources need to turn an output instant into a command list. */
export interface FrameCommandOptions {
  readonly projection: EdgProjection;
  readonly timemap: TimeQuery | null;
  readonly catalogue: ReadonlyMap<string, StyleDoc>;
  readonly registry: FontRegistry;
  readonly shaper: Shaper;
  readonly fps: number;
  /** Drawn on top of every frame; the manifest decided it, not the caller. */
  readonly watermark: DrawCommand | null;
  readonly script?: RenderFrameOptions["script"];
  readonly dropFillers?: boolean;
}

export interface FrameSourceOptions extends FrameCommandOptions {
  readonly backend: SkiaNodeBackend;
  readonly batch: FrameBatch;
}

export interface PooledFrameSourceOptions extends FrameCommandOptions {
  readonly pool: RasterPool;
  /** Total frames the encoder will ask for; the dispatcher stops there. */
  readonly frames: number;
}

export interface FrameStats {
  /** Frames the pipe asked for. */
  readonly requested: number;
  /** Frames Skia actually rasterised. */
  readonly rasterised: number;
  /** Frames served from the previous frame's buffer. */
  readonly reused: number;
  /** `reused / requested`, the number the benchmark quotes. */
  readonly reuseRatio: number;
}

export interface FrameSource {
  /** RGBA for output frame `index`; the buffer is reused between calls. */
  frame(index: number): Uint8Array | Promise<Uint8Array>;
  /**
   * Told when the encoder has finished with a frame's bytes.
   *
   * The inline source ignores it — it owns one buffer and overwrites it — but a
   * pooled frame's slot cannot be reused until the pipe has actually taken the
   * bytes, so this is what makes shared memory safe.
   */
  consumed?(index: number): void;
  /** The command list for one output instant, for tests and diagnostics. */
  commandsAt(outputMs: number): DrawCommand[];
  readonly stats: FrameStats;
}

/**
 * Output time of frame `index`.
 *
 * The **centre** of the frame's interval, not its start: a caption that begins at
 * `t` should be on the first frame whose displayed interval contains `t`, and
 * sampling at the frame start puts it one frame late whenever `t` is not exactly
 * on a frame boundary. Sampling the centre is also what `snapToFrame`'s
 * `"nearest"` mode does, so the renderer and the timeline agree about which
 * frame a cut lands on.
 */
export function frameTimeMs(index: number, fps: number): number {
  return ((index + 0.5) / fps) * 1000;
}

/** The `renderFrame` call both sources make, with the watermark on top. */
function commandBuilder(options: FrameCommandOptions): (outputMs: number) => DrawCommand[] {
  return (outputMs: number) => {
    const commands = renderFrame({
      projection: options.projection,
      timemap: options.timemap,
      catalogue: options.catalogue,
      registry: options.registry,
      shaper: options.shaper,
      outputMs,
      ...(options.script === undefined ? {} : { script: options.script }),
      ...(options.dropFillers === undefined ? {} : { dropFillers: options.dropFillers }),
    });
    // The manifest's watermark is drawn last so nothing can cover it. The
    // projection's own `render.watermarkAssetId` is deliberately not used: the
    // decision that matters is the signed one.
    return options.watermark === null ? commands : [...commands, options.watermark];
  };
}

export function createFrameSource(options: FrameSourceOptions): FrameSource {
  const { backend, batch } = options;
  const commandsAt = commandBuilder(options);
  let requested = 0;
  let rasterised = 0;
  let reused = 0;
  let previousHash: string | null = null;

  return {
    commandsAt,
    get stats(): FrameStats {
      return {
        requested,
        rasterised,
        reused,
        reuseRatio: requested === 0 ? 0 : reused / requested,
      };
    },
    frame(index: number): Uint8Array {
      requested += 1;
      const commands = commandsAt(frameTimeMs(index, options.fps));
      const hash = hashCommands(commands);
      // eslint-disable-next-line security/detect-possible-timing-attacks -- equality check on a null/undefined/status/hash sentinel, not a secret or MAC comparison -- reviewed for M06's eslint-plugin-security promotion
      if (hash === previousHash) {
        reused += 1;
        return batch.buffer;
      }
      previousHash = hash;
      rasterised += 1;
      return batch.render(backend.outline(commands));
    },
  };
}

/**
 * One rasterised frame and everyone still pointing at it.
 *
 * A run of identical frames is one rasterisation and many writes, so the slot
 * has to survive until the last of those writes has left the pipe. The count is
 * incremented at **dispatch** time, synchronously and in frame order, which is
 * what keeps it correct while the workers finish out of order.
 */
class FrameHandle {
  /**
   * One reference for the "current frame" pin the cache holds, and one for
   * every output frame that will be written from it.
   */
  refs = 0;

  constructor(readonly promise: Promise<PoolFrame>) {}

  retain(): void {
    this.refs += 1;
  }
}

export interface PooledFrameSource extends FrameSource {
  /** Awaited by the caller so a failed worker cannot be swallowed. */
  close(): Promise<void>;
}

/**
 * The pooled source: dispatch ahead, write in order.
 *
 * Two rules make this safe. **Dispatch is synchronous and in frame order**, so
 * the cache comparison and the reference counting see frames in the same order a
 * single thread would. **A slot is released only when the encoder says the bytes
 * have gone**, which is why {@link FrameSource.consumed} exists — a slot handed
 * back while its frame was still queued in the pipe would be redrawn underneath
 * ffmpeg.
 *
 * Read-ahead is bounded by the pool's slot count: the dispatcher stops when
 * every slot is spoken for, which is the same bound as the memory.
 */
export function createPooledFrameSource(options: PooledFrameSourceOptions): PooledFrameSource {
  const { pool } = options;
  const commandsAt = commandBuilder(options);
  const handles = new Map<number, FrameHandle>();
  let requested = 0;
  let rasterised = 0;
  let reused = 0;
  let previousHash: string | null = null;
  let current: FrameHandle | null = null;
  let nextDispatch = 0;
  let failure: Error | null = null;

  const drop = (handle: FrameHandle): void => {
    handle.refs -= 1;
    if (handle.refs > 0) return;
    void handle.promise
      .then((frame) => {
        pool.release(frame);
        return frame;
      })
      .catch(() => undefined);
  };

  /** Dispatches while the pool has room and there are frames left to draw. */
  const pump = (): void => {
    while (nextDispatch < options.frames && pool.free > 0) {
      const index = nextDispatch;
      nextDispatch += 1;
      const commands = commandsAt(frameTimeMs(index, options.fps));
      const hash = hashCommands(commands);

      if (hash === previousHash && current !== null) {
        reused += 1;
        // One more output frame will be written from this slot.
        current.retain();
        handles.set(index, current);
        continue;
      }

      previousHash = hash;
      rasterised += 1;
      const handle = new FrameHandle(
        pool.render(commands).catch((error: unknown) => {
          failure ??= error instanceof Error ? error : new Error(String(error));
          throw failure;
        }),
      );
      // Two references, and both are load-bearing: the pin that lets the next
      // identical frame reuse the slot, and this frame's own write. Counting
      // them as one is how a slot gets recycled underneath a caption that was
      // still on screen.
      handle.retain();
      handle.retain();
      if (current !== null) drop(current);
      current = handle;
      handles.set(index, handle);
    }
  };

  return {
    commandsAt,
    get stats(): FrameStats {
      return {
        requested,
        rasterised,
        reused,
        reuseRatio: requested === 0 ? 0 : reused / requested,
      };
    },

    async frame(index: number): Promise<Uint8Array> {
      requested += 1;
      // Keep dispatching until this frame exists, then keep the pipeline full.
      while (!handles.has(index) && nextDispatch <= index) {
        const before = nextDispatch;
        pump();
        if (nextDispatch === before) {
          // Every slot is in use; wait for the oldest outstanding frame.
          const oldest = handles.get(nextDispatch - 1);
          if (oldest === undefined) break;
          await oldest.promise;
        }
      }
      pump();
      const handle = handles.get(index);
      if (handle === undefined) {
        throw failure ?? new Error(`frame ${String(index)} was never dispatched`);
      }
      const frame = await handle.promise;
      return frame.bytes;
    },

    consumed(index: number): void {
      const handle = handles.get(index);
      if (handle === undefined) return;
      handles.delete(index);
      drop(handle);
      pump();
    },

    async close(): Promise<void> {
      if (current !== null) {
        drop(current);
        current = null;
      }
      for (const [index, handle] of handles) {
        handles.delete(index);
        drop(handle);
      }
      await pool.terminate();
      if (failure !== null) throw failure;
    },
  };
}
