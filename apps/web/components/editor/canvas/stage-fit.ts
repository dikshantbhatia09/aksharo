/**
 * FIX-05: the one way chrome sizes a preview of a project canvas. Fits the
 * canvas inside a bounding box, preserving aspect, never upscaling past the
 * box. Every hard-coded 288×162 / aspect-video / aspect-[9/16] this replaced
 * was the audit's "chrome ignores correct data" cause in miniature.
 */
export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

export function fitPreview(
  canvas: CanvasSize,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(maxWidth / canvas.width, maxHeight / canvas.height);
  return {
    width: Math.max(1, Math.round(canvas.width * scale)),
    height: Math.max(1, Math.round(canvas.height * scale)),
  };
}

/**
 * The CSS width that letterboxes a canvas inside a box of the given CSS width
 * and height — `object-fit: contain`, which a plain <div> does not get for free.
 * Pair it with `aspectRatio` and leave height auto, so the height follows.
 *
 * QA found why this is needed: `height: 100%` + `max-width: 100%` + `aspect-ratio`
 * does NOT letterbox. A definite height wins and `max-width` only clips, so a
 * 16:9 document in a narrow pane measured 204x287 — ratio 0.71, a portrait void
 * around a landscape video. `min()` states the contain rule directly and is
 * correct in both orientations under resize, with no JS measurement.
 */
export function containWidth(canvas: CanvasSize, boxWidth: string, boxHeight: string): string {
  return `min(${boxWidth}, ${boxHeight} * ${String(canvas.width / canvas.height)})`;
}

/** CSS `aspect-ratio` value for a canvas, e.g. "1080 / 1920". */
export function aspectRatioOf(canvas: CanvasSize): string {
  return `${String(canvas.width)} / ${String(canvas.height)}`;
}
