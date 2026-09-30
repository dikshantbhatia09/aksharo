/**
 * B-roll (2026-10-05): short picture cutaways over the moments where a speaker
 * names something visual. The document keeps each as an overlay (`kind:
 * "b-roll"`, `schemas/document.ts`, drawn by `render-core`); this module is
 * where one is placed, so Autopilot's finishing pass
 * (`apps/api/src/repurpose/clip-finishing.ts`) and the editor's "Add B-roll
 * here" put a cutaway in the same kind of place:
 *
 * - **on whole words**: it starts as the word that names the thing starts, and
 *   ends as a word ends, about {@link BROLL_RULES}`.targetMs` later;
 * - **never over the hook**: not in the first `hookClearMs` of the video as it
 *   plays (those seconds are the speaker's), nor its last `tailClearMs` (the
 *   payoff, a "Part 2 next" label, an end card), nor over a hook title or an
 *   end card anywhere ({@link blockedBrollSpans});
 * - **spaced out and bounded**: `minGapMs` apart, at most `maxPerClip` of them,
 *   covering at most `maxCoverage` of the video as it plays, all together.
 *
 * "As it plays" is the output clock, after the accepted cuts. `@montaj/timemap`
 * depends on this package, so the caller hands its time map in
 * ({@link BrollClock}) rather than this module importing it.
 *
 * Pure: the same inputs give the same windows on every surface.
 */

import {
  BROLL_DURATION_MS,
  type BRollMode,
  type BRollMotion,
  type BRollOverlay,
  type Overlay,
  type OverlayImage,
} from "./schemas/document.js";

/** Where Autopilot may put a cutaway, and how many (see the module comment). */
export interface BrollRules {
  /** Nothing covers the first ms of the video as it plays: the hook is the speaker's. */
  readonly hookClearMs: number;
  /** Nor its last ms: the payoff, a next-part label, an end card. */
  readonly tailClearMs: number;
  /** About how long a placed cutaway lasts: long enough to see, short enough to keep the speaker. */
  readonly targetMs: number;
  /** The shortest a placed cutaway may play for, after the cuts. */
  readonly minMs: number;
  /** The longest a placed cutaway may be. */
  readonly maxMs: number;
  /** At most this share of the video, as it plays, is covered. */
  readonly maxCoverage: number;
  /** At least this long between two cutaways, as the video plays. */
  readonly minGapMs: number;
  /** At most this many per clip. */
  readonly maxPerClip: number;
  /** A cutaway fades in and out over this long; it also keeps this far off a title or card. */
  readonly fadeMs: number;
}

export const BROLL_RULES: BrollRules = Object.freeze({
  hookClearMs: 3_000,
  tailClearMs: 3_000,
  targetMs: 2_500,
  minMs: 1_500,
  maxMs: 4_000,
  maxCoverage: 0.22,
  minGapMs: 4_000,
  maxPerClip: 5,
  fadeMs: 250,
});

/** A word that plays, on the source clock. */
export interface BrollWord {
  readonly wid: string;
  readonly s: number;
  readonly e: number;
}

/** A window on the source clock. */
export interface BrollSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/** A cutaway's place: its window on the source clock, and the words it covers. */
export interface BrollPlacement extends BrollSpan {
  readonly startWordId: string;
  readonly endWordId: string;
}

/**
 * The video's time map, as far as placing a cutaway needs it
 * (`@montaj/timemap`'s `TimeQuery` is one).
 */
export interface BrollClock {
  readonly outputDurationMs: number;
  /** The output instant of a source instant; `null` inside a cut. */
  toOutput(sourceMs: number): number | null;
}

/** A clock for a video with no cuts: output time is source time. */
export function uncutClock(durationMs: number): BrollClock {
  return {
    outputDurationMs: durationMs,
    toOutput: (sourceMs) => (sourceMs >= 0 && sourceMs <= durationMs ? sourceMs : null),
  };
}

/**
 * The window a cutaway naming `words[from..until]` covers: from the first
 * naming word's start to the end of the word that makes it about `targetMs`
 * long, never past `maxMs` (a naming phrase longer than that is cut there).
 * `undefined` when `from`/`until` are not indices into `words`.
 */
export function brollWindowFrom(
  words: readonly BrollWord[],
  from: number,
  until: number = from,
  options: { readonly targetMs?: number; readonly maxMs?: number } = {},
): BrollPlacement | undefined {
  const first = words.at(from);
  const last = words.at(until);
  if (from < 0 || until < from || first === undefined || last === undefined) return undefined;
  const targetMs = options.targetMs ?? BROLL_RULES.targetMs;
  const maxMs = options.maxMs ?? BROLL_DURATION_MS.max;
  const startMs = first.s;
  let endWord = last;
  // Grow over the following words until it is long enough, never past maxMs.
  for (let at = until + 1; endWord.e - startMs < targetMs; at += 1) {
    const next = words.at(at);
    if (next === undefined || next.e - startMs > maxMs) break;
    endWord = next;
  }
  const endMs = Math.min(endWord.e, startMs + maxMs);
  if (endMs <= startMs) return undefined;
  return { startMs, endMs, startWordId: first.wid, endWordId: endWord.wid };
}

/**
 * Where no cutaway may go (source clock): each hook title (a series label is
 * one) and each end card, where `render-core` would fade a cutaway out anyway.
 */
export function blockedBrollSpans(overlays: readonly Overlay[] | undefined): BrollSpan[] {
  return (overlays ?? [])
    .filter((overlay) => overlay.kind === "hook-title" || overlay.kind === "end-card")
    .map((overlay) => ({ startMs: overlay.startMs, endMs: overlay.endMs }));
}

/** The document's B-roll cutaways, in start order. */
export function brollOverlaysOf(overlays: readonly Overlay[] | undefined): BRollOverlay[] {
  return (overlays ?? [])
    .filter((overlay): overlay is BRollOverlay => overlay.kind === "b-roll")
    .sort((a, b) => a.startMs - b.startMs);
}

/** A proposed cutaway: the words that name the thing, and how strongly they call for a picture. */
export interface BrollProposal {
  /** The first and the last naming word, among the words that play. */
  readonly startWordId: string;
  readonly endWordId: string;
  /** Higher is kept first: how concrete and visual the thing named is (0-10 from the model). */
  readonly score: number;
}

export interface PlanBrollInput {
  readonly proposals: readonly BrollProposal[];
  /** The words that play, in order, on the source clock. */
  readonly words: readonly BrollWord[];
  readonly clock: BrollClock;
  /** Where no cutaway may go (source clock); see {@link blockedBrollSpans}. */
  readonly blocked?: readonly BrollSpan[];
  /** Cutaways already in the document (source clock): kept clear of, and counted. */
  readonly existing?: readonly BrollSpan[];
  readonly rules?: Partial<BrollRules>;
}

/** A proposal that made it: where it goes, and which proposal it was. */
export interface PlannedBroll extends BrollPlacement {
  readonly proposal: number;
}

/** A source instant on the output clock; an instant at a cut's edge reads as the instant before it. */
function outputOf(clock: BrollClock, sourceMs: number): number | null {
  const direct = clock.toOutput(sourceMs);
  if (direct !== null) return direct;
  const before = clock.toOutput(sourceMs - 1);
  return before === null ? null : before + 1;
}

function overlaps(a: BrollSpan, b: BrollSpan): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/**
 * The proposals that fit the rules (see the module comment), strongest first
 * and then earliest, each on whole words; returned in time order. A proposal
 * that does not fit is left out, never moved somewhere its words are not said.
 */
export function planBroll(input: PlanBrollInput): PlannedBroll[] {
  const rules: BrollRules = { ...BROLL_RULES, ...input.rules };
  const { words, clock } = input;
  const total = clock.outputDurationMs;
  if (total <= 0 || words.length === 0) return [];
  const index = new Map(words.map((word, at) => [word.wid, at]));
  const blocked = (input.blocked ?? []).map((span) => ({
    startMs: span.startMs - rules.fadeMs,
    endMs: span.endMs + rules.fadeMs,
  }));

  /** Output windows already taken: the document's own cutaways, then each one kept. */
  const taken: BrollSpan[] = [];
  let covered = 0;
  for (const span of input.existing ?? []) {
    const start = outputOf(clock, span.startMs);
    const end = outputOf(clock, span.endMs);
    if (start === null || end === null || end <= start) continue;
    taken.push({ startMs: start, endMs: end });
    covered += end - start;
  }

  const order = input.proposals
    .map((proposal, at) => ({ proposal, at, from: index.get(proposal.startWordId) }))
    .filter((entry) => entry.from !== undefined)
    .sort(
      (a, b) => b.proposal.score - a.proposal.score || (a.from ?? 0) - (b.from ?? 0) || a.at - b.at,
    );

  const kept: PlannedBroll[] = [];
  for (const { proposal, at, from } of order) {
    if (taken.length >= rules.maxPerClip) break;
    const until = index.get(proposal.endWordId);
    if (from === undefined || until === undefined || until < from) continue;
    const window = brollWindowFrom(words, from, until, {
      targetMs: rules.targetMs,
      maxMs: rules.maxMs,
    });
    if (window === undefined) continue;
    const start = outputOf(clock, window.startMs);
    const end = outputOf(clock, window.endMs);
    if (start === null || end === null) continue;
    const playsFor = end - start;
    if (playsFor < rules.minMs) continue;
    if (start < rules.hookClearMs || end > total - rules.tailClearMs) continue;
    if (blocked.some((span) => overlaps(span, window))) continue;
    const spaced = { startMs: start - rules.minGapMs, endMs: end + rules.minGapMs };
    if (taken.some((span) => overlaps(span, spaced))) continue;
    if (covered + playsFor > rules.maxCoverage * total) continue;
    taken.push({ startMs: start, endMs: end });
    covered += playsFor;
    kept.push({ ...window, proposal: at });
  }
  return kept.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Full frame, unless the picture's shape is so far from the frame's that
 * covering it would crop away more than half of the picture (a wide photo in a
 * tall frame): that one goes in a box beside the speaker instead.
 */
export function brollModeFor(
  image: Pick<OverlayImage, "width" | "height">,
  canvas: { readonly width: number; readonly height: number },
): BRollMode {
  if (image.width <= 0 || image.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    return "full";
  }
  const picture = image.width / image.height;
  const frame = canvas.width / canvas.height;
  const kept = Math.min(picture, frame) / Math.max(picture, frame);
  return kept >= 0.5 ? "full" : "pip";
}

/** The moves a clip's cutaways take in turn, so two in a row never move alike. */
export const BROLL_MOTIONS: readonly BRollMotion[] = Object.freeze([
  "push-in",
  "pan-left",
  "pull-out",
  "pan-right",
]);

/** The move the `index`-th cutaway of a clip takes. */
export function brollMotionAt(index: number): BRollMotion {
  const count = BROLL_MOTIONS.length;
  return BROLL_MOTIONS[((index % count) + count) % count] ?? "push-in";
}

/**
 * A cutaway's window with one edge moved to the next word boundary that way
 * (the editor's trim), or both edges together (its move): `direction` -1 is
 * earlier, 1 later. `undefined` when there is no word to move to, or the result
 * would break {@link BROLL_DURATION_MS}.
 */
export function nudgeBrollWindow(
  window: BrollSpan,
  words: readonly BrollWord[],
  edge: "start" | "end" | "both",
  direction: -1 | 1,
): BrollSpan | undefined {
  if (words.length === 0) return undefined;
  const starts = words.map((word) => word.s);
  const ends = words.map((word) => word.e);
  const step = (value: number, boundaries: readonly number[]): number | undefined =>
    direction > 0
      ? boundaries.find((boundary) => boundary > value)
      : [...boundaries].reverse().find((boundary) => boundary < value);
  let startMs = window.startMs;
  let endMs = window.endMs;
  if (edge === "start") {
    const next = step(startMs, starts);
    if (next === undefined) return undefined;
    startMs = next;
  } else if (edge === "end") {
    const next = step(endMs, ends);
    if (next === undefined) return undefined;
    endMs = next;
  } else {
    const next = step(startMs, starts);
    if (next === undefined) return undefined;
    endMs += next - startMs;
    startMs = next;
  }
  const length = endMs - startMs;
  if (length < BROLL_DURATION_MS.min || length > BROLL_DURATION_MS.max) return undefined;
  return { startMs, endMs };
}
