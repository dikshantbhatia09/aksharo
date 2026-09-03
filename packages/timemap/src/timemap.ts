import { flattenEdits, normaliseEdits } from "./edits.js";
import { assertFiniteMs, TimeMapError } from "./errors.js";
import { assertFps } from "./frames.js";
import { mapKeyframes } from "./keyframes.js";
import { lowerBound, upperBound } from "./search.js";
import { mapSegment, mapWord } from "./segments.js";
import { buildSpans } from "./spans.js";

import type { CutEdit, Edit, HoldEdit, SpeedEdit } from "./edits.js";
import type { Keyframe, MapKeyframesOptions } from "./keyframes.js";
import type { OutputLocation, OutputRange, SourceLocation, TimeQuery } from "./query.js";
import type { MappedSegment, MappedWord, SegmentTimes, WordTimes } from "./segments.js";
import type { TimeSpan } from "./spans.js";

/** Format version of `serialize()` output. Bump only with a migration. */
export const TIMEMAP_FORMAT_VERSION = 1;

/** The JSON shape `serialize()` writes and `parseTimeMap()` reads. */
export interface SerialisedTimeMap {
  readonly v: typeof TIMEMAP_FORMAT_VERSION;
  readonly sourceDurationMs: number;
  readonly fps?: number;
  /** Normalised edits, ordered by source time. Round-tripping is a fixed point. */
  readonly edits: readonly Edit[];
}

/** What `buildTimeMap` takes. */
export interface TimeMapOptions {
  /** Length of the source media, whole milliseconds. */
  readonly sourceDurationMs: number;
  /** Cuts, speed ranges and holds in any order; conflicts are resolved for you. */
  readonly edits?: readonly Edit[] | undefined;
  /** Frame rate of the source; required by `snapCutsToFrames`. */
  readonly fps?: number | undefined;
  /** Snap every cut edge to the nearest frame boundary before merging. Default `false`. */
  readonly snapCutsToFrames?: boolean | undefined;
}

/**
 * An immutable source-time ↔ output-time mapping.
 *
 * Build it once per revision of the edit and share it: every lookup is a binary
 * search over a frozen span list, so it is safe to hold in a React store, a
 * render worker or an NLE panel.
 */
export interface TimeMap extends TimeQuery {
  readonly sourceDurationMs: number;
  readonly outputDurationMs: number;
  /** Frame rate the map was built with, when one was supplied. */
  readonly fps: number | undefined;
  /** Normalised edits, ordered by source time. */
  readonly edits: readonly Edit[];
  /** Merged, disjoint, ordered cuts — the ranges that were removed. */
  readonly cuts: readonly CutEdit[];
  /** Speed ranges after cuts were subtracted. */
  readonly speeds: readonly SpeedEdit[];
  /** Freeze frames that survived. */
  readonly holds: readonly HoldEdit[];
  /** The full ordered span list; the renderer walks this directly. */
  readonly spans: readonly TimeSpan[];

  toOutput(sourceMs: number): number | null;
  toSource(outputMs: number): number;
  isInsideCut(sourceMs: number): boolean;
  /** `toOutput` with the reason attached, and never `null`. */
  locateSource(sourceMs: number): SourceLocation;
  /** `toSource` with the reason attached — the inverse used for scrubbing. */
  locateOutput(outputMs: number): OutputLocation;
  mapRange(startMs: number, endMs: number): OutputRange[];
  mapSegment(segment: SegmentTimes, words?: readonly WordTimes[]): MappedSegment;
  mapWord(word: WordTimes): MappedWord;
  mapKeyframes<K extends Keyframe>(keyframes: readonly K[], options?: MapKeyframesOptions<K>): K[];
  serialize(): SerialisedTimeMap;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Builds the mapping.
 *
 * Cuts win every conflict: overlapping and touching cuts merge, speed ranges are
 * clipped out of them, and holds inside one are dropped. See the README for the
 * boundary rules.
 */
export function buildTimeMap(options: TimeMapOptions): TimeMap {
  const { sourceDurationMs, edits = [], fps, snapCutsToFrames = false } = options;
  if (
    typeof sourceDurationMs !== "number" ||
    !Number.isFinite(sourceDurationMs) ||
    !Number.isInteger(sourceDurationMs) ||
    sourceDurationMs < 0
  ) {
    throw new TimeMapError(
      "invalid-duration",
      `sourceDurationMs must be a whole, non-negative number of milliseconds, got ${String(sourceDurationMs)}`,
      { sourceDurationMs },
    );
  }
  if (fps !== undefined) assertFps(fps);

  const normalised = normaliseEdits(edits, { sourceDurationMs, fps, snapCutsToFrames });
  const spans = buildSpans(normalised, sourceDurationMs);
  const lastSpan = spans[spans.length - 1];
  const outputDurationMs = lastSpan ? lastSpan.outputEnd : 0;

  // Search keys, extracted once. `sourceEnds` is non-decreasing because the spans
  // are in source order; `outputStarts` because they are also in output order.
  const sourceEnds: number[] = new Array<number>(spans.length);
  const outputStarts: number[] = new Array<number>(spans.length);
  for (let i = 0; i < spans.length; i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const span = spans[i] as TimeSpan;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    sourceEnds[i] = span.sourceEnd;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    outputStarts[i] = span.outputStart;
  }

  /** Output instant for a source instant inside `span`. */
  const outputWithin = (span: TimeSpan, sourceMs: number): number =>
    clamp(
      Math.round(span.outputStart + (sourceMs - span.sourceStart) / span.factor),
      span.outputStart,
      span.outputEnd,
    );

  /** Source instant for an output instant inside `span`. */
  const sourceWithin = (span: TimeSpan, outputMs: number): number =>
    clamp(
      Math.round(span.sourceStart + (outputMs - span.outputStart) * span.factor),
      span.sourceStart,
      span.sourceEnd,
    );

  /** The span answering for a source instant: the first whose `sourceEnd >= sourceMs`. */
  const spanForSource = (sourceMs: number): TimeSpan | undefined =>
    spans[Math.min(lowerBound(sourceEnds, sourceMs), spans.length - 1)];

  /** The span answering for an output instant: the last whose `outputStart <= outputMs`. */
  const spanForOutput = (outputMs: number): TimeSpan | undefined =>
    spans[Math.max(upperBound(outputStarts, outputMs), 0)];

  const locateSource = (sourceMs: number): SourceLocation => {
    const raw = assertFiniteMs(sourceMs, "sourceMs");
    const clampedMs = clamp(raw, 0, sourceDurationMs);
    const span = spanForSource(clampedMs);
    if (!span) {
      return { sourceMs: clampedMs, outputMs: 0, insideCut: false, clamped: raw !== clampedMs };
    }
    const insideCut =
      span.kind === "cut" && clampedMs > span.sourceStart && clampedMs < span.sourceEnd;
    const outputMs = span.kind === "retained" ? outputWithin(span, clampedMs) : span.outputStart;
    return { sourceMs: clampedMs, outputMs, insideCut, clamped: raw !== clampedMs };
  };

  const locateOutput = (outputMs: number): OutputLocation => {
    const raw = assertFiniteMs(outputMs, "outputMs");
    const clampedMs = clamp(raw, 0, outputDurationMs);
    const span = spanForOutput(clampedMs);
    if (!span) {
      return { outputMs: clampedMs, sourceMs: 0, held: false, clamped: raw !== clampedMs };
    }
    const sourceMs = span.kind === "retained" ? sourceWithin(span, clampedMs) : span.sourceStart;
    return {
      outputMs: clampedMs,
      sourceMs,
      held: span.kind === "hold",
      clamped: raw !== clampedMs,
    };
  };

  const toOutput = (sourceMs: number): number | null => {
    const located = locateSource(sourceMs);
    return located.insideCut ? null : located.outputMs;
  };

  const toSource = (outputMs: number): number => locateOutput(outputMs).sourceMs;

  const isInsideCut = (sourceMs: number): boolean => locateSource(sourceMs).insideCut;

  const mapRange = (startMs: number, endMs: number): OutputRange[] => {
    const rawStart = assertFiniteMs(startMs, "startMs");
    const rawEnd = assertFiniteMs(endMs, "endMs");
    if (rawStart > rawEnd) {
      throw new TimeMapError("invalid-range", `range runs backwards: ${rawStart} > ${rawEnd}`, {
        startMs: rawStart,
        endMs: rawEnd,
      });
    }
    const low = clamp(rawStart, 0, sourceDurationMs);
    const high = clamp(rawEnd, 0, sourceDurationMs);
    const pieces: OutputRange[] = [];
    if (high <= low) return pieces;

    // Only a cut breaks the range into pieces. A speed change or a freeze frame
    // stays inside one piece: the material is still continuous, so a caption
    // drawn over it must not blink off while the picture is held.
    let pieceStart: number | null = null;
    let pieceEnd = 0;
    const flush = (): void => {
      if (pieceStart === null) return;
      pieces.push({
        sourceStart: pieceStart,
        sourceEnd: pieceEnd,
        // `locateSource` is the same answer `toOutput` gives, and neither end of
        // a piece is ever strictly inside a cut, so both are plain numbers.
        outputStart: locateSource(pieceStart).outputMs,
        outputEnd: locateSource(pieceEnd).outputMs,
      });
      pieceStart = null;
    };

    for (let i = lowerBound(sourceEnds, low); i < spans.length; i += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      const span = spans[i] as TimeSpan;
      if (span.sourceStart >= high) break;
      if (span.kind !== "retained") continue;
      const sourceStart = Math.max(low, span.sourceStart);
      const sourceEnd = Math.min(high, span.sourceEnd);
      if (sourceEnd <= sourceStart) continue;
      if (pieceStart === null) {
        pieceStart = sourceStart;
      } else if (sourceStart !== pieceEnd) {
        flush();
        pieceStart = sourceStart;
      }
      pieceEnd = sourceEnd;
    }
    flush();
    return pieces;
  };

  const map: TimeMap = {
    sourceDurationMs,
    outputDurationMs,
    fps,
    edits: Object.freeze(flattenEdits(normalised)),
    cuts: normalised.cuts,
    speeds: normalised.speeds,
    holds: normalised.holds,
    spans: Object.freeze(spans),
    toOutput,
    toSource,
    isInsideCut,
    locateSource,
    locateOutput,
    mapRange,
    mapSegment: (segment, words) => mapSegment(map, segment, words),
    mapWord: (word) => mapWord(map, word),
    mapKeyframes: <K extends Keyframe>(
      keyframes: readonly K[],
      keyframeOptions?: MapKeyframesOptions<K>,
    ): K[] => mapKeyframes(map, normalised.cuts, keyframes, keyframeOptions),
    serialize: () => ({
      v: TIMEMAP_FORMAT_VERSION,
      sourceDurationMs,
      ...(fps === undefined ? {} : { fps }),
      edits: map.edits,
    }),
  };

  return Object.freeze(map);
}
