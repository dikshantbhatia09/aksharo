/**
 * The watermark, placed where the signed manifest says.
 *
 * `render-core`'s own `watermarkFor` hardcodes the bottom-right corner at 0.85
 * opacity, which is the free tier's mark and the only one the browser exporter
 * needs. A manifest may name any of the four corners and any opacity — a
 * white-label plan puts a workspace's own logo top-left — so the geometry is
 * re-derived here from the same proportions, and the bottom-right case is
 * asserted to be identical to `render-core`'s in `watermark.test.ts`.
 *
 * The mark is drawn as an ordinary `image` command inside the Skia overlay, not
 * as a second ffmpeg `overlay` input: it then obeys the same transform stack, the
 * same frame timing and the same parity gate as everything else on the frame.
 */

import { type DrawCommand } from "@montaj/render-core";
import { type Watermark } from "@montaj/render-manifest";

/** Fraction of the canvas width the mark occupies. */
export const WATERMARK_WIDTH_RATIO = 0.18;
/** Mark aspect: height as a fraction of its own width. */
export const WATERMARK_ASPECT = 0.28;
/** Margin from the canvas edge, as a fraction of canvas height. */
export const WATERMARK_MARGIN_RATIO = 0.03;

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** The `image` command for a watermark, or `null` when the manifest has none. */
export function watermarkCommandFor(
  watermark: Watermark | null,
  canvas: CanvasSize,
): DrawCommand | null {
  if (watermark === null) return null;
  const width = canvas.width * WATERMARK_WIDTH_RATIO;
  const height = width * WATERMARK_ASPECT;
  const margin = canvas.height * WATERMARK_MARGIN_RATIO;

  const left = watermark.position.endsWith("left") ? margin : canvas.width - margin - width;
  const top = watermark.position.startsWith("top") ? margin : canvas.height - margin - height;

  return {
    kind: "image",
    assetId: watermark.assetId,
    dest: [left, top, left + width, top + height],
    opacity: watermark.opacity,
  };
}
