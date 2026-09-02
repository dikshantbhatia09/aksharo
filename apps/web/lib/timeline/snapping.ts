/**
 * Snapping and bounds invariants for dragging a segment edge on the timeline.
 *
 * Every drag that reaches these functions ends in a `SetSegmentBounds`
 * (CONTRACTS §2, `packages/edg/README.md`): `startMs < endMs`, and a segment
 * never overlaps its neighbours — the brief's "never producing overlapping
 * or inverted bounds". `snapToBoundary` handles "snapping to word
 * boundaries with a 40 ms tolerance"; `clampSegmentEdge` handles the
 * invariants, independently, so a caller can clamp without snapping (a plain
 * fine-grained drag) or snap without clamping (finding the nearest word) as
 * needed.
 */

/** The brief's word-gap snap tolerance. */
export const SNAP_TOLERANCE_MS = 40;

/** Minimum segment duration — a zero- or negative-length caption is never producible. */
export const MIN_SEGMENT_MS = 1;

/**
 * The nearest value in `boundaries` to `candidateMs`, if one is within
 * `toleranceMs`; otherwise `candidateMs` unchanged. `boundaries` need not be
 * sorted (word starts/ends from a segment's word span are already close in
 * practice, but this makes no assumption).
 */
export function snapToBoundary(
  candidateMs: number,
  boundaries: readonly number[],
  toleranceMs = SNAP_TOLERANCE_MS,
): number {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const boundary of boundaries) {
    const dist = Math.abs(boundary - candidateMs);
    if (dist < bestDist) {
      bestDist = dist;
      best = boundary;
    }
  }
  if (best !== undefined && bestDist <= toleranceMs) return best;
  return candidateMs;
}

export interface Neighbour {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Clamps a dragged start (or end) edge so the segment stays non-inverted,
 * at least `MIN_SEGMENT_MS` long, and never crosses into `prev`/`next` — the
 * "never producing overlapping or inverted bounds" invariant, independent of
 * whatever snapping already happened.
 */
export function clampSegmentEdge(
  edge: "start" | "end",
  candidateMs: number,
  current: { readonly startMs: number; readonly endMs: number },
  neighbours: { readonly prev?: Neighbour; readonly next?: Neighbour } = {},
): number {
  if (edge === "start") {
    const lowerBound = neighbours.prev !== undefined ? neighbours.prev.endMs : 0;
    const upperBound = current.endMs - MIN_SEGMENT_MS;
    return Math.min(upperBound, Math.max(lowerBound, candidateMs));
  }
  const upperBound = neighbours.next !== undefined ? neighbours.next.startMs : Infinity;
  const lowerBound = current.startMs + MIN_SEGMENT_MS;
  return Math.max(lowerBound, Math.min(upperBound, candidateMs));
}

export interface SnappedBounds {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The full pipeline a segment-edge drag runs through on pointer-up: snap to
 * the nearest word boundary within tolerance, then clamp to the bounds
 * invariants. Order matters — snapping first means a snap that would have
 * produced an overlap gets pulled back by the clamp rather than accepted.
 */
export function resolveSegmentDrag(
  edge: "start" | "end",
  candidateMs: number,
  current: { readonly startMs: number; readonly endMs: number },
  options: {
    readonly wordBoundaries?: readonly number[];
    readonly toleranceMs?: number;
    readonly neighbours?: { readonly prev?: Neighbour; readonly next?: Neighbour };
  } = {},
): SnappedBounds {
  const snapped =
    options.wordBoundaries === undefined
      ? candidateMs
      : snapToBoundary(candidateMs, options.wordBoundaries, options.toleranceMs);
  const clamped = clampSegmentEdge(edge, snapped, current, options.neighbours ?? {});
  return edge === "start"
    ? { startMs: clamped, endMs: current.endMs }
    : { startMs: current.startMs, endMs: clamped };
}

/** `true` when two closed-open segment ranges overlap (touching at an edge is not overlap). */
export function segmentsOverlap(a: Neighbour, b: Neighbour): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** `true` when `bounds` is well-formed and does not overlap any of `others`. */
export function boundsAreValid(bounds: SnappedBounds, others: readonly Neighbour[] = []): boolean {
  if (bounds.endMs - bounds.startMs < MIN_SEGMENT_MS) return false;
  return others.every((other) => !segmentsOverlap(bounds, other));
}
