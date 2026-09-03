/**
 * Bounds resolution for dragging a proposed/accepted cut/zoom/reframe pass
 * item's edge on the timeline (B20b), mirroring `snapping.ts`'s
 * `resolveSegmentDrag`/`resolveWordEdgeDrag` exactly: the drag ends in one
 * `EditPassItem{itemId, startMs, endMs}` op (CONTRACTS §2), so this module's
 * job is to compute bounds the engine can never reject — clamped to
 * `[0, durationMs]`, at least `MIN_PASS_ITEM_MS` long, and never crossing a
 * neighbouring *accepted* item of the same kind (the engine (`packages/edg`
 * `ops/apply.ts` `applyEditPassItem`) clamps the same way server-side; this
 * is the client-side mirror so a drag preview never shows a bound the
 * server would then correct out from under the pointer).
 */

/** Minimum pass-item duration — mirrors `MIN_SEGMENT_MS`/`MIN_WORD_MS`. */
export const MIN_PASS_ITEM_MS = 1;

export interface PassItemBounds {
  readonly startMs: number;
  readonly endMs: number;
}

export interface PassItemNeighbour {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * Clamps a dragged start (or end) edge to `[0, durationMs]`, the item's own
 * minimum length, and the nearest neighbouring *accepted* item of the same
 * kind on that side (`neighbours` should already be filtered to accepted
 * items of the dragged item's kind — this function does not know kinds).
 */
export function clampPassItemEdge(
  edge: "start" | "end",
  candidateMs: number,
  current: PassItemBounds,
  options: {
    readonly durationMs?: number;
    readonly neighbours?: readonly PassItemNeighbour[];
  } = {},
): number {
  const neighbours = options.neighbours ?? [];
  if (edge === "start") {
    const priorNeighbourEnd = neighbours
      .filter((n) => n.endMs <= current.startMs)
      .reduce((max, n) => Math.max(max, n.endMs), 0);
    const upperBound = current.endMs - MIN_PASS_ITEM_MS;
    return Math.min(upperBound, Math.max(priorNeighbourEnd, candidateMs));
  }
  const nextNeighbourStart = neighbours
    .filter((n) => n.startMs >= current.endMs)
    .reduce((min, n) => Math.min(min, n.startMs), options.durationMs ?? Number.POSITIVE_INFINITY);
  const lowerBound = current.startMs + MIN_PASS_ITEM_MS;
  return Math.max(lowerBound, Math.min(nextNeighbourStart, candidateMs));
}

/** The full pipeline a pass-item edge drag runs through on pointer-up. */
export function resolvePassItemDrag(
  edge: "start" | "end",
  candidateMs: number,
  current: PassItemBounds,
  options: {
    readonly durationMs?: number;
    readonly neighbours?: readonly PassItemNeighbour[];
  } = {},
): PassItemBounds {
  const clamped = clampPassItemEdge(edge, candidateMs, current, options);
  return edge === "start"
    ? { startMs: clamped, endMs: current.endMs }
    : { startMs: current.startMs, endMs: clamped };
}
