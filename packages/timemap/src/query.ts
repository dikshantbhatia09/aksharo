/**
 * The read-only half of a `TimeMap`. `mapSegment`, `mapWord` and `mapKeyframes`
 * are written against this so they stay independent of how the map was built.
 */

/** One piece of source time that survived, on both clocks. */
export interface OutputRange {
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly outputStart: number;
  readonly outputEnd: number;
}

/** Where a source instant ended up. */
export interface SourceLocation {
  /** The argument, clamped to `[0, sourceDurationMs]`. */
  readonly sourceMs: number;
  /**
   * Output instant. For an instant strictly inside a cut this is the splice —
   * the output time at which the cut happens — and `insideCut` is `true`.
   */
  readonly outputMs: number;
  /** `true` exactly when `toOutput()` would answer `null`. */
  readonly insideCut: boolean;
  /** `true` when the argument was outside `[0, sourceDurationMs]`. */
  readonly clamped: boolean;
}

/** Where an output instant came from. */
export interface OutputLocation {
  /** The argument, clamped to `[0, outputDurationMs]`. */
  readonly outputMs: number;
  /** The source instant displayed at `outputMs`. */
  readonly sourceMs: number;
  /** `true` when `outputMs` falls inside a freeze frame. */
  readonly held: boolean;
  /** `true` when the argument was outside `[0, outputDurationMs]`. */
  readonly clamped: boolean;
}

/** The lookups every consumer needs; implemented by `TimeMap`. */
export interface TimeQuery {
  readonly sourceDurationMs: number;
  readonly outputDurationMs: number;
  /** Output instant for a source instant, or `null` strictly inside a cut. */
  toOutput(sourceMs: number): number | null;
  /** Source instant displayed at an output instant. Total: always a number. */
  toSource(outputMs: number): number;
  /** `true` when `toOutput(sourceMs)` is `null`. */
  isInsideCut(sourceMs: number): boolean;
  /** The retained pieces of `[startMs, endMs)`, ordered and disjoint. */
  mapRange(startMs: number, endMs: number): OutputRange[];
}
