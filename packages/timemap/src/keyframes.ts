import type { CutEdit } from "./edits.js";
import type { TimeQuery } from "./query.js";

/** Anything with a source-time stamp: reframe rows, zoom ramps, ducking curves. */
export interface Keyframe {
  readonly tMs: number;
}

/** How `mapKeyframes` should behave at a splice. */
export interface MapKeyframesOptions<K extends Keyframe> {
  /**
   * Value at a cut edge. `ratio` runs `0 → 1` from `before` to `after`; return a
   * new keyframe (its `tMs` is overwritten). Without it the edge keyframes hold
   * the neighbouring values, which is the right default for opaque payloads.
   */
  readonly interpolate?: (before: K, after: K, ratio: number) => K;
  /** Insert the two edge keyframes at every splice the curve crosses. Default `true`. */
  readonly insertBoundaries?: boolean;
}

/** Ordering inside one source instant: the pre-splice edge, real keyframes, the post-splice edge. */
const PRE_BOUNDARY = 0;
const REAL = 1;
const POST_BOUNDARY = 2;

interface Entry<K extends Keyframe> {
  readonly sourceMs: number;
  readonly rank: number;
  readonly value: K;
}

function withTime<K extends Keyframe>(value: K, tMs: number): K {
  return { ...value, tMs } as K;
}

/**
 * Remaps a keyframe track onto the output clock.
 *
 * Keyframes strictly inside a cut are dropped. Where a cut falls between two
 * surviving keyframes the curve is **pinned** at the splice: an edge keyframe is
 * added at the cut's start and another at its end, both landing on the same
 * output instant. Without them the interpolation either side of the splice would
 * be stretched across the removed time and the zoom or reframe would visibly
 * drift — the drift D30 exists to prevent.
 *
 * The walk is linear in `keyframes + cuts`: both lists are ordered and a single
 * cursor advances through them. The result is ordered by output time and every
 * `tMs` is an output millisecond.
 */
export function mapKeyframes<K extends Keyframe>(
  map: TimeQuery,
  cuts: readonly CutEdit[],
  keyframes: readonly K[],
  options: MapKeyframesOptions<K> = {},
): K[] {
  const { interpolate, insertBoundaries = true } = options;
  if (keyframes.length === 0) return [];

  const sorted = [...keyframes].sort((a, b) => a.tMs - b.tMs);
  const kept = sorted.filter((keyframe) => !map.isInsideCut(keyframe.tMs));
  if (kept.length === 0) return [];

  const entries: Entry<K>[] = kept.map((value) => ({ sourceMs: value.tMs, rank: REAL, value }));

  if (insertBoundaries) {
    // `cursor` is the index of the last keyframe at or before the current cut's
    // start; it only moves forwards because both lists are sorted.
    let cursor = -1;
    for (const cut of cuts) {
      while (cursor + 1 < kept.length && (kept[cursor + 1] as K).tMs <= cut.startMs) cursor += 1;
      const before = kept[cursor];
      // Nothing survives strictly inside a cut, so the next keyframe is at or
      // after its end — exactly the pair the splice sits between.
      const after = kept[cursor + 1];
      if (!before || !after) continue;
      const span = after.tMs - before.tMs;
      const at = (ms: number, fallback: K): K =>
        interpolate && span > 0 ? interpolate(before, after, (ms - before.tMs) / span) : fallback;
      if (before.tMs !== cut.startMs) {
        entries.push({ sourceMs: cut.startMs, rank: PRE_BOUNDARY, value: at(cut.startMs, before) });
      }
      if (after.tMs !== cut.endMs) {
        entries.push({ sourceMs: cut.endMs, rank: POST_BOUNDARY, value: at(cut.endMs, after) });
      }
    }
  }

  entries.sort((a, b) => a.sourceMs - b.sourceMs || a.rank - b.rank);

  return entries.map((entry) => {
    // Neither a kept keyframe nor a cut edge is ever strictly inside a cut, so
    // `toOutput` always answers with a number here.
    const outputMs = map.toOutput(entry.sourceMs) ?? 0;
    return withTime(entry.value, outputMs);
  });
}
