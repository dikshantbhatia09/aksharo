/**
 * The ±1.5 s scrub preview window (B20b's brief §3) — pure maths, no React,
 * no CanvasKit: given the playhead and the media duration, the clamped
 * `[startMs, endMs]` window to sample frames across, and which of the two
 * render paths a caller should use for it.
 *
 * "Real CanvasKit frames when available, else the crop rectangle only" is a
 * capability the *caller* has (whether a `use-canvaskit.ts` renderer is
 * ready) — this module only decides the *window*, and exposes
 * {@link scrubPreviewMode} as the one place that capability turns into a
 * mode name, so `CaptionStage`'s scrub-preview wiring and any test double
 * agree on what the two mode strings mean.
 */

export const SCRUB_PREVIEW_HALF_WINDOW_MS = 1_500;

export interface ScrubPreviewWindow {
  readonly startMs: number;
  readonly endMs: number;
  /** The instant the preview is centred on — usually the playhead itself. */
  readonly centerMs: number;
}

/**
 * The ±1.5 s window around `playheadMs`, clamped to `[0, durationMs]`. Never
 * inverted: a `durationMs` shorter than the full window still returns a
 * valid (if narrower) range.
 */
export function scrubPreviewWindow(
  playheadMs: number,
  durationMs: number,
  halfWindowMs: number = SCRUB_PREVIEW_HALF_WINDOW_MS,
): ScrubPreviewWindow {
  const center = Math.min(Math.max(0, playheadMs), Math.max(0, durationMs));
  return {
    startMs: Math.max(0, center - halfWindowMs),
    endMs: Math.min(durationMs, center + halfWindowMs),
    centerMs: center,
  };
}

export type ScrubPreviewMode = "frames" | "rect-only";

/**
 * `"frames"` when a real CanvasKit renderer is ready to draw the scrubbed
 * frames themselves; `"rect-only"` (the brief's explicit fallback) when it
 * is not — still loading its wasm module, or the browser export path is
 * unavailable altogether (`use-canvaskit.ts`'s own `ready` flag already
 * distinguishes these cases; this function only names the two outcomes).
 */
export function scrubPreviewMode(canvasKitReady: boolean): ScrubPreviewMode {
  return canvasKitReady ? "frames" : "rect-only";
}
