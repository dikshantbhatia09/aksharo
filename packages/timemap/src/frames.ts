import { TimeMapError } from "./errors.js";

/** Which way `snapToFrame` moves a time that falls between two frame boundaries. */
export type SnapMode = "nearest" | "floor" | "ceil";

/** Highest frame rate we accept; above this a "frame" is shorter than a millisecond. */
const MAX_FPS = 1000;

/** Throws unless `fps` is a finite rate in `(0, 1000]`. */
export function assertFps(fps: number): number {
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0 || fps > MAX_FPS) {
    throw new TimeMapError("invalid-fps", `fps must be a finite number in (0, ${MAX_FPS}]`, {
      fps,
    });
  }
  return fps;
}

/** Length of one frame in milliseconds — fractional for 23.976, 29.97 and 59.94. */
export function frameDurationMs(fps: number): number {
  return 1000 / assertFps(fps);
}

/** Frame index containing `ms`, counting from 0 at the start of the media. */
export function frameAt(ms: number, fps: number): number {
  return Math.floor((ms * assertFps(fps)) / 1000);
}

/**
 * Rounds `ms` onto a frame boundary.
 *
 * Frame boundaries are computed from the exact rate (`ms * fps / 1000`), so
 * 29.97 fps snaps onto the real 33.3667 ms grid rather than a 33 ms
 * approximation, and only the final millisecond value is rounded.
 */
export function snapToFrame(ms: number, fps: number, mode: SnapMode = "nearest"): number {
  assertFps(fps);
  if (!Number.isFinite(ms)) {
    throw new TimeMapError("invalid-time", `ms must be a finite number, got ${String(ms)}`, { ms });
  }
  const exactFrame = (ms * fps) / 1000;
  // Nudge away from binary-float noise so 1000 ms at 25 fps is frame 25, not 24.999…
  const nudged =
    Math.abs(exactFrame - Math.round(exactFrame)) < 1e-9 ? Math.round(exactFrame) : exactFrame;
  const frame =
    mode === "floor"
      ? Math.floor(nudged)
      : mode === "ceil"
        ? Math.ceil(nudged)
        : Math.round(nudged);
  return Math.round((frame * 1000) / fps);
}
