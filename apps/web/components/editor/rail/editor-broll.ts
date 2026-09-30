/**
 * The editor's B-roll (2026-10-05), the pure half: which words play, where
 * "Add" puts a cutaway (the word under the playhead), and the overlay a chosen
 * picture becomes. `BrollPanel` shows it; `editor-client.tsx` submits the ops.
 */
import {
  brollModeFor,
  brollMotionAt,
  brollPlacementProblem,
  brollWindowFrom,
  newId,
  type BRollOverlay,
  type BrollClock,
  type BrollPlacement,
  type BrollPlacementProblem,
  type BrollSpan,
  type PassItem,
} from "@montaj/edg";

import type { BrollPanelWord } from "./BrollPanel";

import { overlayImageOfPicture, type BrollPicture } from "@/components/broll/use-broll-library";

/** A word as the editor's state keeps it. */
interface StateWord {
  readonly wid: string;
  readonly t: string;
  readonly s: number;
  readonly e: number;
  readonly deleted?: boolean;
}

/** The words that play, in time order: not deleted, and not inside an accepted cut. */
export function playingWordsOf(
  words: Iterable<StateWord>,
  items: readonly PassItem[],
): BrollPanelWord[] {
  const cuts = items
    .filter((item) => item.kind === "cut" && item.state === "accepted")
    .map((item) => [item.startMs, item.endMs] as const);
  return [...words]
    .filter((word) => word.deleted !== true && word.t.trim() !== "")
    .filter((word) => !cuts.some(([start, end]) => word.s < end && word.e > start))
    .map((word) => ({ wid: word.wid, t: word.t, s: word.s, e: Math.max(word.e, word.s) }))
    .sort((a, b) => a.s - b.s);
}

/** Where "Add" puts a cutaway: the word under (or next after) the playhead, and whether it may. */
export interface BrollAddAt {
  readonly word: string;
  readonly startMs: number;
  readonly window: BrollPlacement;
  readonly problem?: BrollPlacementProblem;
}

export function brollAddAt(input: {
  readonly words: readonly BrollPanelWord[];
  readonly playheadMs: number;
  readonly clock: BrollClock;
  readonly blocked: readonly BrollSpan[];
}): BrollAddAt | undefined {
  const index = input.words.findIndex((word) => word.e > input.playheadMs);
  const word = index < 0 ? undefined : input.words.at(index);
  if (word === undefined) return undefined;
  const window = brollWindowFrom(input.words, index);
  if (window === undefined) return undefined;
  const problem = brollPlacementProblem(window, { clock: input.clock, blocked: input.blocked });
  return {
    word: word.t,
    startMs: word.s,
    window,
    ...(problem === undefined ? {} : { problem }),
  };
}

/**
 * The cutaway a chosen picture becomes: over `window`, full frame unless the
 * picture's shape would lose most of itself to the frame, the next move in
 * turn, labelled with what the picture is.
 */
export function cutawayForPicture(input: {
  readonly picture: BrollPicture;
  readonly window: BrollPlacement;
  readonly canvas: { readonly width: number; readonly height: number };
  /** How many cutaways the clip has already: picks the move. */
  readonly index: number;
  readonly id?: string;
}): BRollOverlay {
  const { picture, window } = input;
  const label = (picture.title ?? picture.tags[0] ?? "").trim().slice(0, 80).trim();
  return {
    id: input.id ?? newId(),
    kind: "b-roll",
    startMs: window.startMs,
    endMs: window.endMs,
    image: overlayImageOfPicture(picture),
    mode: brollModeFor(picture, input.canvas),
    motion: brollMotionAt(input.index),
    startWordId: window.startWordId as BRollOverlay["startWordId"],
    endWordId: window.endWordId as BRollOverlay["endWordId"],
    ...(label === "" ? {} : { label }),
  };
}
