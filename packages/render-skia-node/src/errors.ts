/**
 * Failures the Skia-in-Node backend can raise, with codes a render worker can
 * put straight into a completion callback.
 */

export type SkiaNodeErrorCode =
  /** A `text` command reached the executor with no shaper to outline it. */
  | "skia-node/no-shaper"
  /** An image the backend was handed could not be decoded. */
  | "skia-node/bad-image"
  /** A surface of the requested size could not be created. */
  | "skia-node/no-surface"
  /** A command carried geometry the executor cannot express. */
  | "skia-node/unsupported-command";

export class SkiaNodeError extends Error {
  public override readonly name = "SkiaNodeError";

  constructor(
    readonly code: SkiaNodeErrorCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function isSkiaNodeError(error: unknown, code?: SkiaNodeErrorCode): error is SkiaNodeError {
  return error instanceof SkiaNodeError && (code === undefined || error.code === code);
}
