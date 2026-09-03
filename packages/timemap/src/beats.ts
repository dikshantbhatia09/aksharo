/**
 * Beat-aligned cut boundaries (D05, brief §3): snapping an accepted cut's
 * `startMs`/`endMs` to the nearest beat of a target BPM, so a music-driven
 * edit's cuts land on-beat rather than a millisecond off. Off by default —
 * `PassesService`/the caller decides whether to request it at all; this
 * module only supplies the pure snap function and its guard rules.
 *
 * Works entirely in **output time** (the brief's own instruction, echoing
 * B18b/B19b): a cut boundary read off an accepted `PassItem` is already an
 * output-clock instant once earlier cuts have been applied (`fromAcceptedItems`
 * builds the very `TimeMap` that clock is defined on), so this module takes
 * plain millisecond boundaries and never touches a `TimeQuery` itself — the
 * caller is responsible for resolving whichever clock it needs before calling
 * in, and for re-applying an adjustment through the ordinary `EditPassItem` op
 * (CONTRACTS §2) once accepted, exactly as the brief's "emitted as
 * `EditPassItem`-style adjustments" describes.
 */

/** Default tolerance: a boundary snaps only if the nearest beat is within
 * ±120 ms (brief §3) — a boundary further from any beat is left alone. */
export const DEFAULT_BEAT_SNAP_TOLERANCE_MS = 120;

/** One cut item's two boundaries, as read off an accepted `PassItem`. */
export interface CutBoundaryInput {
  readonly itemId: string;
  readonly startMs: number;
  readonly endMs: number;
}

/** One boundary nudge — shaped like an `EditPassItem` op's own delta, not the
 * op itself (this package has no dependency on `@montaj/edg`'s op builders). */
export interface BeatBoundaryAdjustment {
  readonly itemId: string;
  readonly field: "startMs" | "endMs";
  readonly fromMs: number;
  readonly toMs: number;
}

export interface AlignCutBoundariesToBeatsOptions {
  /** The music pass's own BPM target (`MusicPayload`'s implied grid, or the
   * worker's `bpmTarget` result field) — the grid every boundary snaps to. */
  readonly bpm: number;
  /** Beat grid phase, output-clock milliseconds (default `0`: a beat exactly
   * on the timeline's own zero). */
  readonly anchorMs?: number;
  /** Maximum snap distance (default {@link DEFAULT_BEAT_SNAP_TOLERANCE_MS}). */
  readonly toleranceMs?: number;
  /**
   * Ranges a snapped boundary must never land inside (CONTRACTS' protected
   * ranges) — a candidate snap that would land strictly inside one of these
   * is dropped, the boundary is left at its original millisecond instead of
   * being clamped to the range's edge (same "dropped, not shortened" stance
   * `worker_ai.passes.sfx.build_sfx_items` takes for a cue).
   */
  readonly protectedRanges?: readonly (readonly [number, number])[];
}

function nearestBeatMs(ms: number, bpm: number, anchorMs: number): number {
  const intervalMs = 60_000 / bpm;
  const beatIndex = Math.round((ms - anchorMs) / intervalMs);
  return anchorMs + beatIndex * intervalMs;
}

function insideAnyRange(ms: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([start, end]) => ms > start && ms < end);
}

/**
 * The beat grid's own instants inside `[startMs, endMs]` — exposed mainly for
 * tests and UI beat-ruler overlays; `alignCutBoundariesToBeats` does not need
 * it (it only ever asks for the *nearest* beat to one instant).
 */
export function beatTimesInRange(
  bpm: number,
  startMs: number,
  endMs: number,
  anchorMs = 0,
): number[] {
  if (bpm <= 0 || endMs < startMs) return [];
  const intervalMs = 60_000 / bpm;
  const firstIndex = Math.ceil((startMs - anchorMs) / intervalMs);
  const times: number[] = [];
  for (let index = firstIndex; ; index += 1) {
    const t = anchorMs + index * intervalMs;
    if (t > endMs) break;
    if (t >= startMs) times.push(t);
  }
  return times;
}

/**
 * Snaps each cut's `startMs`/`endMs` to the nearest beat of `options.bpm`,
 * within `options.toleranceMs` (default ±120 ms) and never landing inside a
 * protected range. A boundary whose nearest beat is further than the
 * tolerance, or would land inside a protected range, is left untouched (no
 * adjustment emitted for it) rather than snapped to a worse beat.
 *
 * Returns only the adjustments that actually move a boundary — a boundary
 * already exactly on a beat produces none.
 */
export function alignCutBoundariesToBeats(
  cuts: readonly CutBoundaryInput[],
  options: AlignCutBoundariesToBeatsOptions,
): BeatBoundaryAdjustment[] {
  const toleranceMs = options.toleranceMs ?? DEFAULT_BEAT_SNAP_TOLERANCE_MS;
  const anchorMs = options.anchorMs ?? 0;
  const protectedRanges = options.protectedRanges ?? [];
  if (options.bpm <= 0) return [];

  const adjustments: BeatBoundaryAdjustment[] = [];
  for (const cut of cuts) {
    for (const field of ["startMs", "endMs"] as const) {
      // eslint-disable-next-line security/detect-object-injection -- field is one of the two literals in the const tuple above, not attacker-controlled -- reviewed for D05
      const originalMs = cut[field];
      const snappedMs = nearestBeatMs(originalMs, options.bpm, anchorMs);
      if (snappedMs === originalMs) continue;
      if (Math.abs(snappedMs - originalMs) > toleranceMs) continue;
      if (insideAnyRange(snappedMs, protectedRanges)) continue;
      adjustments.push({ itemId: cut.itemId, field, fromMs: originalMs, toMs: snappedMs });
    }
  }
  return adjustments;
}
