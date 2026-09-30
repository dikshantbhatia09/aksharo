import {
  BROLL_RULES,
  brollModeFor,
  brollMotionAt,
  planBroll,
  stableOverlayId,
  type BrollClock,
  type BrollProposal,
  type BrollSpan,
  type PlannedBroll,
} from "@montaj/edg";
import type { BRollOverlay, PassItem, TranscriptChunk } from "@montaj/edg/schemas";
import { BROLL_LIMITS, type BrollMoment, type BrollRequest } from "@montaj/repurpose-contracts";

import {
  bestPicture,
  overlayImageOfPicture,
  type LibraryPicture,
  type SpokenTag,
} from "../broll/broll-match.js";

/**
 * Autopilot's B-roll (2026-10-05), the pure half of the finishing pass's
 * `broll` step (`clip-finishing.ts`): which words a clip plays, what the
 * language model is asked about them, which proposed moments can be shown and
 * where, and the overlay each becomes.
 *
 * Proposals come two ways, and both are placed by the same rules
 * (`@montaj/edg` `planBroll`: on whole words, never over the hook's first
 * seconds, the last seconds, a hook title or an end card, spaced out, at most
 * 22 % of the video as it plays):
 *
 * 1. the model's moments (`ai.llm` kind `broll`), each with a search phrase;
 * 2. every tag of a library picture the speaker says word for word
 *    (`spokenTags`), which needs no model and names its own picture.
 *
 * Each is filled from the workspace's library first (`bestPicture`); a moment
 * no picture matches can only be shown when stock photos are set up, and is
 * left out otherwise, before it takes any of the clip's room. Nothing is added
 * when nothing fits.
 */

/** A word that plays, with its text. */
export interface ClipWord {
  readonly wid: string;
  readonly t: string;
  readonly s: number;
  readonly e: number;
}

/** A proposal and what it is about; a spoken tag also names its picture. */
export interface ClipProposal extends BrollProposal {
  readonly phrase: string;
  readonly spoken: string;
  readonly pictureId?: string;
}

/** A moment that will be shown: where, what it is about, and its library picture (if any yet). */
export interface ClipBrollPlan {
  readonly planned: PlannedBroll;
  readonly proposal: ClipProposal;
  readonly picture: LibraryPicture | undefined;
}

/** The words of a clip that play: not deleted, and not inside an accepted cut. */
export function playingWords(
  chunks: readonly TranscriptChunk[],
  items: readonly PassItem[],
): ClipWord[] {
  const cuts = items
    .filter((item) => item.kind === "cut" && item.state === "accepted")
    .map((item) => [item.startMs, item.endMs] as const);
  return chunks
    .flatMap((chunk) => chunk.words)
    .filter((word) => word.deleted !== true && word.t.trim() !== "")
    .filter((word) => !cuts.some(([start, end]) => word.s < end && word.e > start))
    .map((word) => ({ wid: word.wid, t: word.t, s: word.s, e: Math.max(word.e, word.s) }));
}

/**
 * The source-clock spans no cutaway may cover, as the model is told them: the
 * first `hookClearMs` and the last `tailClearMs` of the video as it plays,
 * and every hook title and end card (`blocked`).
 */
export function brollAvoidSpans(input: {
  readonly toSource: (outputMs: number) => number;
  readonly outputDurationMs: number;
  readonly sourceDurationMs: number;
  readonly blocked: readonly BrollSpan[];
}): BrollSpan[] {
  const spans: BrollSpan[] = [];
  const hookEnd = Math.round(
    input.toSource(Math.min(BROLL_RULES.hookClearMs, input.outputDurationMs)),
  );
  if (hookEnd > 0) spans.push({ startMs: 0, endMs: hookEnd });
  const tailStart = Math.round(
    input.toSource(Math.max(0, input.outputDurationMs - BROLL_RULES.tailClearMs)),
  );
  if (input.sourceDurationMs > tailStart) {
    spans.push({ startMs: tailStart, endMs: input.sourceDurationMs });
  }
  return [...spans, ...input.blocked].filter((span) => span.endMs > span.startMs);
}

/** What the language model is asked for one clip (`params.broll` of its `ai.llm` job). */
export function brollRequestOf(input: {
  readonly words: readonly ClipWord[];
  readonly language: string;
  readonly title?: string;
  readonly avoid: readonly BrollSpan[];
}): BrollRequest {
  const title = input.title?.trim().slice(0, BROLL_LIMITS.titleMax).trim();
  return {
    schemaVersion: 1,
    language: input.language.trim().slice(0, 64),
    ...(title === undefined || title === "" ? {} : { title }),
    words: input.words.slice(0, BROLL_LIMITS.maxWords).map((word) => ({
      id: word.wid,
      t: word.t.trim().slice(0, BROLL_LIMITS.maxWordChars),
      s: word.s,
      e: word.e,
    })),
    maxMoments: BROLL_LIMITS.maxMoments,
    minGapMs: BROLL_RULES.minGapMs,
    avoid: input.avoid.slice(0, BROLL_LIMITS.maxAvoid).map((span) => ({
      startMs: Math.max(0, Math.round(span.startMs)),
      endMs: Math.max(0, Math.round(span.endMs)),
    })),
  };
}

function overlapping(a: { s: number; e: number }, b: { s: number; e: number }): boolean {
  return a.s < b.e && b.s < a.e;
}

/**
 * Every proposal, the model's moments first; a spoken tag whose words a moment
 * already covers is left out (the moment is the same place, and its picture is
 * found by the tag anyway).
 */
export function proposalsFrom(
  moments: readonly BrollMoment[],
  tagged: readonly SpokenTag[],
  words: readonly ClipWord[],
): ClipProposal[] {
  const at = new Map(words.map((word) => [word.wid, word]));
  const span = (proposal: BrollProposal) => ({
    s: at.get(proposal.startWordId)?.s ?? Number.NaN,
    e: at.get(proposal.endWordId)?.e ?? Number.NaN,
  });
  const fromModel: ClipProposal[] = moments.map((moment) => ({
    startWordId: moment.startWordId,
    endWordId: moment.endWordId,
    score: moment.score,
    phrase: moment.phrase,
    spoken: moment.spoken,
  }));
  const fromTags: ClipProposal[] = [];
  for (const tag of tagged) {
    const here = span(tag);
    if (fromModel.some((moment) => overlapping(span(moment), here))) continue;
    if (fromTags.some((other) => overlapping(span(other), here))) continue;
    fromTags.push({
      startWordId: tag.startWordId,
      endWordId: tag.endWordId,
      score: tag.score,
      phrase: tag.phrase,
      spoken: words
        .filter((word) => word.s >= here.s && word.e <= here.e)
        .map((word) => word.t)
        .join(" "),
      pictureId: tag.pictureId,
    });
  }
  return [...fromModel, ...fromTags];
}

/** The library picture a proposal names or matches best, not minding what is already used. */
function libraryPictureFor(
  proposal: ClipProposal,
  pictures: readonly LibraryPicture[],
  options: {
    readonly canvas: { readonly width: number; readonly height: number };
    readonly used?: ReadonlySet<string>;
  },
): LibraryPicture | undefined {
  if (proposal.pictureId !== undefined) {
    return pictures.find((picture) => picture.id === proposal.pictureId);
  }
  return bestPicture(pictures, { phrase: proposal.phrase, spoken: proposal.spoken }, options);
}

/**
 * The moments that will be shown, placed, each with its library picture - or
 * none yet, for one a stock photo is to fill. A moment no picture matches is
 * left out before it takes any room unless `stockEnabled`.
 */
export function brollPlan(input: {
  readonly proposals: readonly ClipProposal[];
  readonly pictures: readonly LibraryPicture[];
  readonly words: readonly ClipWord[];
  readonly clock: BrollClock;
  readonly blocked: readonly BrollSpan[];
  readonly canvas: { readonly width: number; readonly height: number };
  readonly stockEnabled: boolean;
}): ClipBrollPlan[] {
  const fillable = input.proposals.filter(
    (proposal) =>
      input.stockEnabled ||
      libraryPictureFor(proposal, input.pictures, { canvas: input.canvas }) !== undefined,
  );
  const planned = planBroll({
    proposals: fillable,
    words: input.words,
    clock: input.clock,
    blocked: input.blocked,
  });
  const used = new Set<string>();
  return planned.flatMap((entry) => {
    const proposal = fillable.at(entry.proposal);
    if (proposal === undefined) return [];
    const picture = libraryPictureFor(proposal, input.pictures, { canvas: input.canvas, used });
    if (picture !== undefined) used.add(picture.id);
    return [{ planned: entry, proposal, picture }];
  });
}

/** How a frame is shaped, as a stock search filters photos by it. */
export function orientationOf(canvas: {
  readonly width: number;
  readonly height: number;
}): "portrait" | "landscape" | "square" {
  if (canvas.height > canvas.width * 1.1) return "portrait";
  if (canvas.width > canvas.height * 1.1) return "landscape";
  return "square";
}

/**
 * The overlay a shown moment becomes: the shape's own stable id for its
 * `index`-th cutaway (so a repeated ask sets the same ones), full frame unless
 * the picture's shape would lose most of itself to this frame, and the next
 * move in turn.
 */
export function brollOverlayFor(input: {
  readonly variantId: string;
  readonly index: number;
  readonly planned: PlannedBroll;
  readonly proposal: ClipProposal;
  readonly picture: LibraryPicture;
  readonly canvas: { readonly width: number; readonly height: number };
}): BRollOverlay {
  const label = input.proposal.phrase.trim().slice(0, 80).trim();
  return {
    id: stableOverlayId(`${input.variantId}:broll:${String(input.index)}`),
    kind: "b-roll",
    startMs: input.planned.startMs,
    endMs: input.planned.endMs,
    image: overlayImageOfPicture(input.picture),
    mode: brollModeFor(input.picture, input.canvas),
    motion: brollMotionAt(input.index),
    startWordId: input.planned.startWordId as BRollOverlay["startWordId"],
    endWordId: input.planned.endWordId as BRollOverlay["endWordId"],
    ...(label === "" ? {} : { label }),
  };
}
