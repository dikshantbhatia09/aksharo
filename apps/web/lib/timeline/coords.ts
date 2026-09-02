/**
 * Time <-> pixel maths for the timeline (A17), kept out of React so it can be
 * unit-tested without a canvas or a DOM.
 *
 * The whole timeline is drawn at one zoom level, expressed as milliseconds
 * per pixel (`msPerPx`) rather than a "percent" — a linear zoom in ms/px
 * makes "twice as zoomed in" exactly halve `msPerPx`, which is what a
 * mouse-wheel zoom step and a minimap ratio both want. The brief's range is
 * "1 px = 5 ms ... 1 s", i.e. `msPerPx` in `[MIN_MS_PER_PX, MAX_MS_PER_PX]`.
 */

/** Most zoomed in: 5 ms per pixel. */
export const MIN_MS_PER_PX = 5;
/** Most zoomed out: 1 s per pixel. */
export const MAX_MS_PER_PX = 1000;

/** A wheel/button zoom step multiplies `msPerPx` by this (or divides, to zoom in). */
export const ZOOM_STEP_FACTOR = 1.25;

export function clampMsPerPx(msPerPx: number): number {
  if (!Number.isFinite(msPerPx) || msPerPx <= 0) return MIN_MS_PER_PX;
  return Math.min(MAX_MS_PER_PX, Math.max(MIN_MS_PER_PX, msPerPx));
}

/** Zooms in (smaller `msPerPx`) or out around a pixel anchor, keeping the time under the anchor fixed. */
export function zoomAround(
  current: { readonly msPerPx: number; readonly scrollMs: number },
  anchorPx: number,
  direction: "in" | "out",
): { readonly msPerPx: number; readonly scrollMs: number } {
  const anchorMs = current.scrollMs + anchorPx * current.msPerPx;
  const nextMsPerPx = clampMsPerPx(
    direction === "in" ? current.msPerPx / ZOOM_STEP_FACTOR : current.msPerPx * ZOOM_STEP_FACTOR,
  );
  const nextScrollMs = Math.max(0, anchorMs - anchorPx * nextMsPerPx);
  return { msPerPx: nextMsPerPx, scrollMs: nextScrollMs };
}

export interface Viewport {
  /** Timeline scroll position, in source ms, at the left edge of the drawn area. */
  readonly scrollMs: number;
  readonly msPerPx: number;
  /** Width of the drawn area, CSS px. */
  readonly widthPx: number;
}

export function msToPx(ms: number, viewport: Viewport): number {
  return (ms - viewport.scrollMs) / viewport.msPerPx;
}

export function pxToMs(px: number, viewport: Viewport): number {
  return viewport.scrollMs + px * viewport.msPerPx;
}

/** The `[startMs, endMs]` actually visible, with `paddingPx` extra on each side for virtualised draw lookahead. */
export function visibleRange(
  viewport: Viewport,
  paddingPx = 0,
): { readonly startMs: number; readonly endMs: number } {
  const startMs = Math.max(0, pxToMs(-paddingPx, viewport));
  const endMs = pxToMs(viewport.widthPx + paddingPx, viewport);
  return { startMs, endMs };
}

/** Clamps `scrollMs` so the viewport never scrolls past `[0, durationMs]`. */
export function clampScroll(scrollMs: number, viewport: Pick<Viewport, "msPerPx" | "widthPx">, durationMs: number): number {
  const maxScroll = Math.max(0, durationMs - viewport.widthPx * viewport.msPerPx);
  if (!Number.isFinite(scrollMs)) return 0;
  return Math.min(maxScroll, Math.max(0, scrollMs));
}

/**
 * A "nice" ruler tick step (ms) for the given `msPerPx`, so labels never
 * crowd regardless of zoom: 1/2/5/10/20/50... ms/s/min steps, picked so a
 * tick lands at least `minPx` apart on screen.
 */
const NICE_STEPS_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000,
  300_000, 600_000, 1_800_000, 3_600_000,
];

export function tickStepMs(msPerPx: number, minPx = 80): number {
  const minStep = minPx * msPerPx;
  for (const step of NICE_STEPS_MS) {
    if (step >= minStep) return step;
  }
  return NICE_STEPS_MS[NICE_STEPS_MS.length - 1] ?? 3_600_000;
}

/** Ticks covering `[startMs, endMs]`, aligned to `tickStepMs`'s grid. */
export function ruleTicks(startMs: number, endMs: number, msPerPx: number, minPx = 80): number[] {
  const step = tickStepMs(msPerPx, minPx);
  const first = Math.ceil(startMs / step) * step;
  const ticks: number[] = [];
  for (let t = first; t <= endMs; t += step) ticks.push(t);
  return ticks;
}
