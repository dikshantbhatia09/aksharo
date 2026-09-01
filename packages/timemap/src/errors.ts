/**
 * Typed failures. Every rejection from this package is a `TimeMapError` carrying
 * a stable `code`, so callers can branch on the reason without parsing English.
 */

/** Why a `TimeMapError` was raised. Stable strings; add, never rename. */
export type TimeMapErrorCode =
  /** `sourceDurationMs` is not a whole, non-negative, finite number of milliseconds. */
  | "invalid-duration"
  /** A time argument is not a finite number. */
  | "invalid-time"
  /** A range argument runs backwards (`startMs > endMs`). */
  | "invalid-range"
  /** An edit is structurally wrong: negative, fractional, or `startMs > endMs`. */
  | "invalid-edit"
  /** A `speed` edit's `factor` is not a finite number greater than zero. */
  | "invalid-factor"
  /** `fps` is not a finite number in `(0, 1000]`. */
  | "invalid-fps"
  /** Two `speed` edits cover the same source millisecond. */
  | "overlapping-speed"
  /** `snapCutsToFrames` was asked for without an `fps`. */
  | "missing-fps"
  /** A serialised document carries a format version this build cannot read. */
  | "unsupported-version"
  /** A serialised document is not shaped like a `SerialisedTimeMap`. */
  | "malformed-document";

/** The only error this package throws. */
export class TimeMapError extends Error {
  override readonly name = "TimeMapError";

  /** Machine-readable reason; see `TimeMapErrorCode`. */
  readonly code: TimeMapErrorCode;

  /** Whatever context helps a caller report the problem; never a secret. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: TimeMapErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

/** `true` when `value` is a `TimeMapError`, optionally of a particular `code`. */
export function isTimeMapError(value: unknown, code?: TimeMapErrorCode): value is TimeMapError {
  return value instanceof TimeMapError && (code === undefined || value.code === code);
}

/** Throws unless `value` is a whole, finite, non-negative count of milliseconds. */
export function assertWholeMs(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new TimeMapError(
      "invalid-edit",
      `${label} must be a whole, non-negative number of milliseconds, got ${String(value)}`,
      { label, value },
    );
  }
  return value;
}

/** Throws unless `value` is a finite number; used for query arguments, which may be fractional. */
export function assertFiniteMs(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TimeMapError(
      "invalid-time",
      `${label} must be a finite number, got ${String(value)}`,
      {
        label,
        value,
      },
    );
  }
  return value;
}
