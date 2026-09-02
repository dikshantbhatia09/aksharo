/** Errors `render-core` raises. Every one names the thing that was missing. */

export type RenderErrorCode =
  /** No registered font can draw the text, not even through a fallback. */
  | "render/no-font"
  /** The HarfBuzz wasm module could not be loaded. */
  | "render/shaper-unavailable"
  /** A style document referenced by a segment is not in the catalogue. */
  | "render/unknown-style"
  /** A caller passed a canvas, time or size the layout cannot work with. */
  | "render/invalid-input";

export class RenderError extends Error {
  override readonly name = "RenderError";
  constructor(
    readonly code: RenderErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isRenderError(value: unknown): value is RenderError {
  return value instanceof RenderError;
}
