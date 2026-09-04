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

/** CSS `aspect-ratio` value for a canvas, e.g. "1080 / 1920". */
export function aspectRatioOf(canvas: CanvasSize): string {
  return `${String(canvas.width)} / ${String(canvas.height)}`;
}
