/**
 * Pure logic for the Passes tab / ProposalCard / bulk accept (B20 increment
 * 2): building `DecideItems` ops, filtering and grouping proposals, and the
 * bulk-accept predicates ("Accept all >= 0.8"). Kept free of React so it is
 * unit-testable the way `apps/web/lib/edg/ops.ts`'s builders are, and reused
 * by both `PassesTab` and its tests.
 */
import type { EdgOp, ItemState, Pass, PassItem } from "@montaj/edg";

/** Matches `apps/web/lib/edg/ops.ts`'s `OpIdFactory` convention. */
export type OpIdFactory = () => string;

/** Builds one `DecideItems` op over a batch of item ids. */
export function decideItems(
  itemIds: readonly string[],
  state: ItemState,
  newOpId: OpIdFactory,
): EdgOp {
  return { type: "DecideItems", opId: newOpId(), itemIds: [...itemIds], state };
}

/** A pass item alongside the pass it belongs to — what a `ProposalCard` renders. */
export interface ReviewRow {
  readonly pass: Pass;
  readonly item: PassItem;
}

/** Flattens every pass's items into review rows, newest pass first. */
export function reviewRows(passes: readonly Pass[]): ReviewRow[] {
  return [...passes]
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .flatMap((pass) => pass.items.map((item) => ({ pass, item })));
}

export interface ReviewFilters {
  readonly kind?: PassItem["kind"] | "all";
  readonly status?: ItemState | "all";
  /** Only rows with `confidence >= minConfidence`; items with no confidence always pass. */
  readonly minConfidence?: number;
}

export function filterRows(rows: readonly ReviewRow[], filters: ReviewFilters): ReviewRow[] {
  const kind = filters.kind ?? "all";
  const status = filters.status ?? "all";
  const minConfidence = filters.minConfidence ?? 0;
  return rows.filter(({ item }) => {
    if (kind !== "all" && item.kind !== kind) return false;
    if (status !== "all" && item.state !== status) return false;
    if (item.confidence !== undefined && item.confidence < minConfidence) return false;
    return true;
  });
}

/** Item ids whose confidence is at or above `threshold` and are still `proposed`. */
export function itemsAtOrAbove(rows: readonly ReviewRow[], threshold: number): string[] {
  return rows
    .filter(({ item }) => item.state === "proposed" && (item.confidence ?? 0) >= threshold)
    .map(({ item }) => item.itemId);
}

/** Every still-`proposed` item id of one kind, for "accept all cuts" style bulk actions. */
export function proposedItemIdsOfKind(
  rows: readonly ReviewRow[],
  kind: PassItem["kind"],
): string[] {
  return rows
    .filter(({ item }) => item.kind === kind && item.state === "proposed")
    .map(({ item }) => item.itemId);
}

/** Every decided (non-`proposed`) item id — what "Reset decisions" sets back to `proposed`. */
export function decidedItemIds(rows: readonly ReviewRow[]): string[] {
  return rows.filter(({ item }) => item.state !== "proposed").map(({ item }) => item.itemId);
}

/**
 * The removed duration and resulting output length for the summary bar —
 * accepted `cut` items only, in whole milliseconds, disjoint-merged so an
 * overlap between two passes is not double-counted.
 */
export function summaryDurations(
  rows: readonly ReviewRow[],
  sourceDurationMs: number,
): { removedMs: number; resultingMs: number } {
  const accepted = rows
    .filter(({ item }) => item.kind === "cut" && item.state === "accepted")
    .map(({ item }) => ({ startMs: item.startMs, endMs: item.endMs }))
    .sort((a, b) => a.startMs - b.startMs);

  let removedMs = 0;
  let cursor = -1;
  for (const cut of accepted) {
    const start = Math.max(cut.startMs, cursor);
    if (cut.endMs > start) removedMs += cut.endMs - start;
    cursor = Math.max(cursor, cut.endMs);
  }
  return { removedMs, resultingMs: Math.max(0, sourceDurationMs - removedMs) };
}
