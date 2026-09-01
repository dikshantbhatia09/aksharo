import type { ItemState, PassItem } from "@montaj/edg";

import { buildTimeMap } from "./timemap.js";

import type { CutEdit, Edit } from "./edits.js";
import type { TimeMap } from "./timemap.js";

/**
 * The part of `PassItem` this package reads (CONTRACTS §2). Derived from the
 * frozen union rather than restated, so any `PassItem` is assignable and a change
 * to the contract is a compile error here.
 */
export type PassItemTimes = Pick<PassItem, "kind" | "state" | "startMs" | "endMs">;

/** What `fromAcceptedItems` takes besides the items. */
export interface FromAcceptedItemsOptions {
  /** Length of the source media, whole milliseconds. */
  readonly sourceDurationMs: number;
  readonly fps?: number | undefined;
  readonly snapCutsToFrames?: boolean | undefined;
  /**
   * Item states that count as applied. Default `["accepted"]` — a `modified`
   * item is an open review decision, not an edit, until the UI accepts it.
   */
  readonly states?: readonly ItemState[] | undefined;
  /** Speed ranges and holds to apply alongside the cuts; they carry no pass item. */
  readonly extraEdits?: readonly Edit[] | undefined;
}

const DEFAULT_STATES: readonly ItemState[] = ["accepted"];

/** The cut edits an item list contributes, without building a map. */
export function cutsFromItems(
  items: readonly PassItemTimes[],
  states: readonly ItemState[] = DEFAULT_STATES,
): CutEdit[] {
  const wanted = new Set(states);
  const cuts: CutEdit[] = [];
  for (const item of items) {
    // Items of every other kind (zoom, reframe, sfx, music, title) leave the
    // timeline alone; only a cut removes source time.
    if (item.kind !== "cut" || !wanted.has(item.state)) continue;
    cuts.push({ kind: "cut", startMs: item.startMs, endMs: item.endMs });
  }
  return cuts;
}

/**
 * Builds a `TimeMap` from a pass's items.
 *
 * Only accepted `cut` items change the timeline; every other kind is ignored.
 * Overlapping cuts — two passes proposing the same silence — merge, so passing
 * the items of several passes at once is safe.
 */
export function fromAcceptedItems(
  items: readonly PassItemTimes[],
  options: FromAcceptedItemsOptions,
): TimeMap {
  const { sourceDurationMs, fps, snapCutsToFrames, states, extraEdits = [] } = options;
  return buildTimeMap({
    sourceDurationMs,
    edits: [...cutsFromItems(items, states), ...extraEdits],
    fps,
    snapCutsToFrames,
  });
}
