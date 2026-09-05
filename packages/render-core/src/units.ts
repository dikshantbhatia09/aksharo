/**
 * Relative sizing (StyleDoc v2, `@montaj/caption-styles/schema`).
 *
 * A style document carries no pixels. Type size and the position of the caption
 * box are percentages of the **canvas height**; the safe-area margin is a
 * percentage of the **canvas's short side**; stroke width, shadow offset and blur,
 * box padding and corner radius are percentages of the **font size**. One document
 * therefore renders identically at 1080×1920 and at the 540×960 proxy, which is the
 * whole point of the preview being trustworthy.
 *
 * Every conversion in the layout engine goes through this module so that "which
 * base is this a percentage of?" is answered in one place.
 */

import { RenderError } from "./errors.js";

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
}

/** Validates a canvas and returns it narrowed, so callers can trust the numbers. */
export function assertCanvas(canvas: CanvasSize): CanvasSize {
  const { width, height } = canvas;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new RenderError(
      "render/invalid-input",
      `canvas must be positive and finite, got ${String(width)}×${String(height)}`,
      { width, height },
    );
  }
  return canvas;
}

/** A percentage of the canvas height in pixels. */
export function ofCanvasHeight(percent: number, canvas: CanvasSize): number {
  return (percent / 100) * canvas.height;
}

/**
 * A percentage of the canvas's SHORT side in pixels — the safe-area rule.
 * Height-based margins on a 9:16 canvas made the horizontal clamp nearly twice
 * the intended zone; S-01 moved the editor's guides to the short side, and this
 * is the render half, so what the editor shows is what the export clamps to.
 */
export function ofCanvasShortSide(percent: number, canvas: CanvasSize): number {
  return (percent / 100) * Math.min(canvas.width, canvas.height);
}

/** A percentage of the canvas width in pixels. */
export function ofCanvasWidth(percent: number, canvas: CanvasSize): number {
  return (percent / 100) * canvas.width;
}

/** A percentage of the font size in pixels. */
export function ofFontSize(percent: number, fontSizePx: number): number {
  return (percent / 100) * fontSizePx;
}

/**
 * A CSS-style blur radius as the Gaussian sigma Skia wants. Skia's own
 * `SkBlurMask::ConvertRadiusToSigma` is `radius × 0.57735 + 0.5`; both backends
 * take sigma, so the conversion happens here, once, and the golden hashes carry
 * the converted value.
 */
export function blurRadiusToSigma(radiusPx: number): number {
  return radiusPx <= 0 ? 0 : radiusPx * 0.57735 + 0.5;
}

/** Clamps to `[min, max]`; `NaN` collapses to `min`, never to a surprise. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return value < min ? min : value > max ? max : value;
}

/** `clamp(value, 0, 1)`. */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * Rounds to a fixed number of decimals so that two runs of the same input
 * produce byte-identical JSON. Layout maths is float; golden hashes are not, so
 * every coordinate that reaches a `DrawCommand` is quantised here.
 *
 * Three decimals is well below a sixteenth of a pixel at 4K and keeps the
 * commands readable in a diff.
 */
export const COORDINATE_DECIMALS = 3;

const COORDINATE_SCALE = 10 ** COORDINATE_DECIMALS;

/** Quantises one coordinate. `-0` is normalised to `0`. */
export function q(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RenderError("render/invalid-input", `coordinate is not finite: ${String(value)}`);
  }
  const rounded = Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
  return rounded === 0 ? 0 : rounded;
}

/** Quantises an `[l, t, r, b]` rectangle. */
export function qRect(
  left: number,
  top: number,
  right: number,
  bottom: number,
): readonly [number, number, number, number] {
  return [q(left), q(top), q(right), q(bottom)];
}
