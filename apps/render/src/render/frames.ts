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

export interface FrameSourceOptions {
  readonly backend: SkiaNodeBackend;
  readonly batch: FrameBatch;
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
  frame(index: number): Uint8Array;
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

export function createFrameSource(options: FrameSourceOptions): FrameSource {
  const { backend, batch } = options;
  let requested = 0;
  let rasterised = 0;
  let reused = 0;
  let previousHash: string | null = null;

  const commandsAt = (outputMs: number): DrawCommand[] => {
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
