import { newId as defaultNewId, parseWordId, type WordId } from "../ids.js";
import { type ProtectedRange } from "../schemas/document.js";
import {
  type DecideItemsOp,
  type EdgOp,
  type EdgSource,
  type EditWordOp,
  type DeleteWordOp,
  type HideSegmentOp,
  type InsertWordAfterOp,
  type MergePassOp,
  type MergeSegmentsOp,
  type OpRejection,
  type OpRejectionReason,
  type ResegmentOp,
  type SetAudioOp,
  type SetEmphasisOp,
  type SetRenderOp,
  type SetSegmentBoundsOp,
  type SetSegmentPositionOp,
  type SetProtectedRangesOp,
  type SetSegmentTextOp,
  type SetStyleOp,
  type SetWordTimingOp,
  type SplitSegmentOp,
} from "../schemas/ops.js";
import { type Emphasis, type Segment } from "../schemas/segment.js";
import { type SegmenterParams, segmentWords } from "../segmenter/segmenter.js";
import { compareSeqKeys, seqBetween } from "../seq.js";
import { type IndexedWord } from "../transcript-index.js";
import {
  draftLiveWords,
  type EdgDraft,
  type EdgState,
  fromDraft,
  chunkStartsOf,
  insertWordAfter,
  maxWordSeqOf,
  nextLiveWord,
  orderIndexOf,
  positionOf,
  previousLiveWord,
  putSegment,
  putWord,
  rememberOpId,
  removeSegment,
  segmentsOnBoundary,
  toDraft,
  wordAfter,
} from "./state.js";

/**
 * `applyOps` — the one implementation of what an `EdgOp` means (D29).
 *
 * It is pure: it copies the parts of the state a batch touches, applies each op
 * in order, and returns a new state plus the per-op verdict. The API module runs
 * it inside the compare-and-swap transaction, the browser applies the same ops
 * optimistically, and a worker replays them over a snapshot — all three get the
 * same document because all three call this function.
 *
 * Ops are **individually** accepted or rejected: one bad op in a batch of fifty
 * does not roll back the other forty-nine. Each op is atomic on its own — a
 * handler validates everything before it writes anything.
 */

/** Where the batch came from, and what the engine may mint while applying it. */
export interface ApplyContext {
  /** Writer identity. Only `worker` may submit `MergePass` (CONTRACTS §2). */
  source?: EdgSource;
  /** Id factory for segments `Resegment` creates. Defaults to the ULID factory. */
  newId?: () => string;
  /** Segmentation defaults; a `Resegment` op overrides the four limits it carries. */
  segmenter?: Partial<SegmenterParams>;
  /** Leave filler words out when `Resegment` rebuilds the captions. */
  dropFillers?: boolean;
  /** Revision this batch produced; stamped on `meta` when anything applied. */
  revision?: number;
}

export interface ApplyResult {
  /** The document after the batch. */
  state: EdgState;
  /** `opId`s that landed, including retries the idempotency window swallowed. */
  applied: string[];
  /** `opId`s that did not land, with a closed-enum reason. */
  rejected: OpRejection[];
  /** The subset of `applied` that was a retry of an op already in the document. */
  skipped: string[];
}

/** Where a document-scope `SetStyle` puts its overrides inside `styles.inline`. */
export const DOC_STYLE_OVERRIDE_KEY = "doc";

/** Internal control flow: a handler gives up before it has written anything. */
class OpRejectedError extends Error {
  override readonly name = "OpRejectedError";
  constructor(
    readonly reason: OpRejectionReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

function fail(reason: OpRejectionReason, detail: string): never {
  throw new OpRejectedError(reason, detail);
}

/* ------------------------------- lookups --------------------------------- */

function liveSegment(draft: EdgDraft, segmentId: string): Segment {
  const segment = draft.segments.get(segmentId);
  if (segment !== undefined) return segment;
  fail(
    draft.tombstones.has(segmentId) ? "stale" : "unknown-id",
    `segment ${segmentId} is not in the document`,
  );
}

function liveWord(draft: EdgDraft, wordId: string): IndexedWord {
  const word = draft.words.get(wordId as WordId);
  if (word === undefined) fail("unknown-id", `word ${wordId} is not in the transcript`);
  if (word.deleted === true) fail("stale", `word ${wordId} is deleted`);
  return word;
}

function requirePosition(draft: EdgDraft, wordId: string): number {
  const position = positionOf(draft, wordId);
  if (position === undefined) fail("unknown-id", `word ${wordId} is not in the transcript`);
  return position;
}

function requireFreeSegmentId(draft: EdgDraft, segmentId: string): void {
  if (draft.segments.has(segmentId) || draft.tombstones.has(segmentId)) {
    fail("invariant", `segment id ${segmentId} is already in use; ids are never reused`);
  }
}

/** Emphasis inside `[from, to]`, in document order. */
function emphasisWithin(
  draft: EdgDraft,
  emphasis: readonly Emphasis[] | undefined,
  from: number,
  to: number,
): Emphasis[] {
  return sortEmphasis(
    draft,
    (emphasis ?? []).filter((entry) => {
      const position = positionOf(draft, entry.wordId);
      return position !== undefined && position >= from && position <= to;
    }),
  );
}

/**
 * Keeps a boundary recomputed from the words from crossing the one that did not
 * move. It only bites when a client had already dragged the caption's timing
 * away from its words: the side that still has its word wins, and the segment
 * collapses onto it rather than running backwards.
 */
function orderTimes(segment: Segment, moved: "start" | "end"): Segment {
  if (segment.startMs <= segment.endMs) return segment;
  return moved === "start"
    ? { ...segment, endMs: segment.startMs }
    : { ...segment, startMs: segment.endMs };
}

function sortEmphasis(draft: EdgDraft, emphasis: readonly Emphasis[]): Emphasis[] {
  return [...emphasis].sort(
    (a, b) => (positionOf(draft, a.wordId) ?? 0) - (positionOf(draft, b.wordId) ?? 0),
  );
}

/* ------------------------------- handlers -------------------------------- */

function applySetSegmentText(draft: EdgDraft, op: SetSegmentTextOp): void {
  const segment = liveSegment(draft, op.segmentId);
  putSegment(draft, {
    ...segment,
    textOverrides: { ...segment.textOverrides, [op.script]: op.text },
  });
}

function applySetSegmentBounds(draft: EdgDraft, op: SetSegmentBoundsOp): void {
  const segment = liveSegment(draft, op.segmentId);
  if (op.startMs > op.endMs) {
    fail("invalid-range", `startMs ${op.startMs} is after endMs ${op.endMs}`);
  }
  const startWordId = op.startWordId ?? segment.startWordId;
  const endWordId = op.endWordId ?? segment.endWordId;
  if (op.startWordId !== undefined) liveWord(draft, op.startWordId);
  if (op.endWordId !== undefined) liveWord(draft, op.endWordId);

  const startPosition = positionOf(draft, startWordId);
  const endPosition = positionOf(draft, endWordId);
  if (startPosition !== undefined && endPosition !== undefined && startPosition > endPosition) {
    fail("invalid-range", `${startWordId} is after ${endWordId} in the transcript`);
  }

  const emphasis =
    startPosition === undefined || endPosition === undefined
      ? segment.emphasis
      : emphasisWithin(draft, segment.emphasis, startPosition, endPosition);

  putSegment(draft, {
    ...segment,
    startWordId,
    endWordId,
    startMs: op.startMs,
    endMs: op.endMs,
    emphasis,
  });
}

function applySplitSegment(draft: EdgDraft, op: SplitSegmentOp): void {
  const segment = liveSegment(draft, op.segmentId);
  requireFreeSegmentId(draft, op.newSegmentId);
  const at = liveWord(draft, op.atWordId);
  const startPosition = requirePosition(draft, segment.startWordId);
  const endPosition = requirePosition(draft, segment.endWordId);
  const atPosition = requirePosition(draft, op.atWordId);
  if (atPosition <= startPosition || atPosition > endPosition) {
    fail("invalid-range", `${op.atWordId} is not a split point inside ${op.segmentId}`);
  }
  const headEnd = previousLiveWord(draft, atPosition, startPosition);
  if (headEnd === undefined) {
    fail("invalid-range", `no live word remains before ${op.atWordId}`);
  }
  const headEndPosition = requirePosition(draft, headEnd.wid);

  const index = orderIndexOf(draft, segment.id, segment.seq);
  const followingId = draft.order[index + 1];
  const following = followingId === undefined ? undefined : draft.segments.get(followingId);
  const seq = seqBetween(segment.seq, following?.seq);

  const tail: Segment = orderTimes(
    {
      ...segment,
      id: op.newSegmentId,
      seq,
      startWordId: op.atWordId,
      endWordId: segment.endWordId,
      startMs: at.s,
      endMs: segment.endMs,
      // The override described the whole line; after a split it only fits the head.
      textOverrides: undefined,
      emphasis: emphasisWithin(draft, segment.emphasis, atPosition, endPosition),
    },
    "start",
  );
  putSegment(
    draft,
    orderTimes(
      {
        ...segment,
        endWordId: headEnd.wid,
        endMs: headEnd.e,
        emphasis: emphasisWithin(draft, segment.emphasis, startPosition, headEndPosition),
      },
      "end",
    ),
  );
  putSegment(draft, tail);
}

/** Per-script overrides every merged segment carried, joined in order. */
function mergeTextOverrides(segments: readonly Segment[]): Record<string, string> | undefined {
  const first = segments[0];
  if (first === undefined) return undefined;
  const scripts = Object.keys(first.textOverrides ?? {}).filter((script) =>
    segments.every((segment) => segment.textOverrides?.[script] !== undefined),
  );
  if (scripts.length === 0) return undefined;
  const merged: Record<string, string> = {};
  for (const script of scripts) {
    merged[script] = segments.map((segment) => segment.textOverrides?.[script] ?? "").join(" ");
  }
  return merged;
}

/**
 * The first (or last) word any of these segments reaches, in document order.
 *
 * Not simply the first segment's `startWordId`: `seq` orders captions on screen
 * and a client may set bounds that do not follow it, so two neighbours can hold
 * word ranges the other way round. The merged caption has to span them all, the
 * same way its times take the minimum and the maximum.
 *
 * `undefined` when the transcript is not loaded, and the caller keeps the ends
 * that `seq` order suggests.
 */
function outermostWord(
  draft: EdgDraft,
  segments: readonly Segment[],
  edge: "start" | "end",
): WordId | undefined {
  let chosen: WordId | undefined;
  let chosenPosition: number | undefined;
  for (const segment of segments) {
    const wordId = edge === "start" ? segment.startWordId : segment.endWordId;
    const position = positionOf(draft, wordId);
    if (position === undefined) return undefined;
    if (
      chosenPosition === undefined ||
      (edge === "start" ? position < chosenPosition : position > chosenPosition)
    ) {
      chosen = wordId;
      chosenPosition = position;
    }
  }
  return chosen;
}

function applyMergeSegments(draft: EdgDraft, op: MergeSegmentsOp): void {
  if (new Set(op.segmentIds).size !== op.segmentIds.length) {
    fail("invalid", "segmentIds repeats an id");
  }
  requireFreeSegmentId(draft, op.newSegmentId);
  const segments = op.segmentIds
    .map((id) => liveSegment(draft, id))
    .sort((a, b) => compareSeqKeys(a.seq, b.seq));

  const indices = segments.map((segment) => orderIndexOf(draft, segment.id, segment.seq));
  for (let i = 1; i < indices.length; i += 1) {
    const previous = indices[i - 1];
    const current = indices[i];
    if (previous === undefined || current === undefined || current !== previous + 1) {
      fail("not-contiguous", "MergeSegments only joins neighbouring segments");
    }
  }

  const first = segments[0];
  const last = segments[segments.length - 1];
  if (first === undefined || last === undefined)
    fail("invalid", "MergeSegments needs two segments");

  const seen = new Set<string>();
  const emphasis: Emphasis[] = [];
  for (const segment of segments) {
    for (const entry of segment.emphasis ?? []) {
      if (seen.has(entry.wordId)) continue;
      seen.add(entry.wordId);
      emphasis.push(entry);
    }
  }

  const merged: Segment = {
    ...first,
    id: op.newSegmentId,
    seq: first.seq,
    startWordId: outermostWord(draft, segments, "start") ?? first.startWordId,
    endWordId: outermostWord(draft, segments, "end") ?? last.endWordId,
    startMs: Math.min(...segments.map((segment) => segment.startMs)),
    endMs: Math.max(...segments.map((segment) => segment.endMs)),
    textOverrides: mergeTextOverrides(segments),
    emphasis: sortEmphasis(draft, emphasis),
  };

  for (const segment of segments) removeSegment(draft, segment.id);
  putSegment(draft, merged);
}

function applySetEmphasis(draft: EdgDraft, op: SetEmphasisOp): void {
  const segment = liveSegment(draft, op.segmentId);
  liveWord(draft, op.wordId);
  const position = requirePosition(draft, op.wordId);
  const startPosition = requirePosition(draft, segment.startWordId);
  const endPosition = requirePosition(draft, segment.endWordId);
  if (position < startPosition || position > endPosition) {
    fail("invalid-range", `${op.wordId} is outside segment ${op.segmentId}`);
  }
  const rest = (segment.emphasis ?? []).filter((entry) => entry.wordId !== op.wordId);
  const emphasis =
    op.presetId === null ? rest : [...rest, { wordId: op.wordId, presetId: op.presetId }];
  putSegment(draft, { ...segment, emphasis: sortEmphasis(draft, emphasis) });
}

function applySetSegmentPosition(draft: EdgDraft, op: SetSegmentPositionOp): void {
  const segment = liveSegment(draft, op.segmentId);
  putSegment(draft, { ...segment, position: op.position ?? undefined });
}

function applyHideSegment(draft: EdgDraft, op: HideSegmentOp): void {
  const segment = liveSegment(draft, op.segmentId);
  putSegment(draft, { ...segment, hidden: op.hidden });
}

function applySetStyle(draft: EdgDraft, op: SetStyleOp): void {
  if (op.styleRef === undefined && op.overrides === undefined) {
    fail("invalid", "SetStyle carries neither styleRef nor overrides");
  }
  if (op.scope === "segment") {
    if (op.segmentId === undefined) fail("invalid", "SetStyle scope segment needs a segmentId");
    const segment = liveSegment(draft, op.segmentId);
    putSegment(draft, {
      ...segment,
      styleRef: op.styleRef ?? segment.styleRef,
      overrides: op.overrides ?? segment.overrides,
    });
    return;
  }
  const styles = { ...draft.hot.styles };
  if (op.styleRef !== undefined) styles.defaultStyleId = op.styleRef;
  if (op.overrides !== undefined) {
    styles.inline = { ...styles.inline, [DOC_STYLE_OVERRIDE_KEY]: op.overrides };
  }
  draft.hot = { ...draft.hot, styles };
}

function applyEditWord(draft: EdgDraft, op: EditWordOp): void {
  const word = liveWord(draft, op.wordId);
  if (op.script === undefined) {
    putWord(draft, { ...word, t: op.text });
    return;
  }
  if (op.script === "translated") {
    fail("invalid", "Word.scripts has no translated slot; edit the en script");
  }
  putWord(draft, { ...word, scripts: { ...word.scripts, [op.script]: op.text } });
}

/** Shrinks a segment onto its remaining live words, hiding it when none are left. */
function shrinkOntoLiveWords(draft: EdgDraft, segmentId: string, deleted: WordId): void {
  const segment = draft.segments.get(segmentId);
  if (segment === undefined) return;
  const startPosition = positionOf(draft, segment.startWordId);
  const endPosition = positionOf(draft, segment.endWordId);
  if (startPosition === undefined || endPosition === undefined) return;

  let next: Segment = segment;
  let moved: "start" | "end" = "end";
  if (segment.startWordId === deleted) {
    const replacement = nextLiveWord(draft, startPosition, endPosition);
    if (replacement === undefined) {
      putSegment(draft, { ...segment, hidden: true });
      return;
    }
    next = { ...next, startWordId: replacement.wid, startMs: replacement.s };
    moved = "start";
  }
  if (segment.endWordId === deleted) {
    const replacement = previousLiveWord(draft, endPosition, startPosition);
    if (replacement === undefined) {
      putSegment(draft, { ...segment, hidden: true });
      return;
    }
    next = { ...next, endWordId: replacement.wid, endMs: replacement.e };
    moved = "end";
  }
  next = orderTimes(next, moved);
  const from = requirePosition(draft, next.startWordId);
  const to = requirePosition(draft, next.endWordId);
  if (from > to) {
    putSegment(draft, { ...segment, hidden: true });
    return;
  }
  putSegment(draft, { ...next, emphasis: emphasisWithin(draft, next.emphasis, from, to) });
}

function applyDeleteWord(draft: EdgDraft, op: DeleteWordOp): void {
  const word = draft.words.get(op.wordId);
  if (word === undefined) fail("unknown-id", `word ${op.wordId} is not in the transcript`);
  if (word.deleted === true) return;
  putWord(draft, { ...word, deleted: true });
  draft.tombstones.add(op.wordId);
  for (const segmentId of segmentsOnBoundary(draft, op.wordId)) {
    shrinkOntoLiveWords(draft, segmentId, op.wordId);
  }
}

function applyInsertWordAfter(draft: EdgDraft, op: InsertWordAfterOp): void {
  const anchor = draft.words.get(op.wordId);
  if (anchor === undefined) fail("unknown-id", `word ${op.wordId} is not in the transcript`);
  if (anchor.deleted === true) fail("stale", `word ${op.wordId} is deleted`);
  if (draft.words.has(op.newWordId) || draft.tombstones.has(op.newWordId)) {
    fail("invariant", `word id ${op.newWordId} is already in use; ids are never reused`);
  }
  const anchorId = parseWordId(op.wordId);
  const newId = parseWordId(op.newWordId);
  if (newId.chunkIdx !== anchorId.chunkIdx) {
    fail("invalid", `${op.newWordId} must belong to chunk ${anchorId.chunkIdx}`);
  }
  const highest = maxWordSeqOf(draft).get(newId.chunkIdx);
  if (highest !== undefined && newId.n <= highest) {
    fail("invariant", `${op.newWordId} must be allocated from nextWordSeq (past ${highest})`);
  }
  if (op.s > op.e) fail("invalid-range", `s ${op.s} is after e ${op.e}`);
  if (op.s < anchor.e) fail("invalid-range", `${op.newWordId} starts before ${op.wordId} ends`);
  const following = wordAfter(draft, op.wordId);
  if (following !== undefined && op.e > following.s) {
    fail("invalid-range", `${op.newWordId} runs past the start of ${following.wid}`);
  }

  const chunkStart = chunkStartsOf(draft).get(newId.chunkIdx) ?? 0;
  insertWordAfter(draft, op.wordId, {
    wid: op.newWordId,
    s: op.s,
    e: op.e,
    t: op.text,
    chunkIdx: newId.chunkIdx,
    offsetMs: op.s - chunkStart,
  });
}

/** The segment whose word range covers `position`, or `undefined` if none does. */
function containingSegment(draft: EdgDraft, position: number): Segment | undefined {
  for (const segment of draft.segments.values()) {
    const from = positionOf(draft, segment.startWordId);
    const to = positionOf(draft, segment.endWordId);
    if (from === undefined || to === undefined) continue;
    if (position >= from && position <= to) return segment;
  }
  return undefined;
}

/**
 * Retimes one word. Segment bounds are a separate op and are never recomputed
 * here, but the new range must still leave `validateProjection` happy, so a
 * range that would push the word outside its containing segment is rejected
 * the same as one that overlaps a neighbour.
 */
function applySetWordTiming(draft: EdgDraft, op: SetWordTimingOp): void {
  if (op.s >= op.e) fail("invalid-range", `s ${op.s} must be before e ${op.e}`);
  const word = liveWord(draft, op.wordId);

  const chunkBounds = draft.chunks.get(word.chunkIdx);
  if (chunkBounds !== undefined && (op.s < chunkBounds.startMs || op.e > chunkBounds.endMs)) {
    fail("invalid-range", `${op.wordId} would cross chunk ${word.chunkIdx}'s bounds`);
  }

  const position = requirePosition(draft, op.wordId);
  const prev = previousLiveWord(draft, position, -Infinity);
  if (prev !== undefined && prev.chunkIdx === word.chunkIdx && op.s < prev.e) {
    fail("invalid-range", `${op.wordId} would overlap the previous word ${prev.wid}`);
  }
  const next = nextLiveWord(draft, position, Infinity);
  if (next !== undefined && next.chunkIdx === word.chunkIdx && op.e > next.s) {
    fail("invalid-range", `${op.wordId} would overlap the next word ${next.wid}`);
  }

  const segment = containingSegment(draft, position);
  if (segment !== undefined && (op.s < segment.startMs || op.e > segment.endMs)) {
    fail("invalid-range", `${op.wordId} would move outside segment ${segment.id}`);
  }

  putWord(draft, { ...word, s: op.s, e: op.e });
}

/** The media duration ranges clamp to: the primary media, or the longest media. */
function mediaDurationMs(draft: EdgDraft): number | undefined {
  const primary = draft.hot.media.find((media) => media.role === "primary");
  if (primary !== undefined) return primary.durationMs;
  return draft.hot.media.reduce<number | undefined>(
    (max, media) => (max === undefined || media.durationMs > max ? media.durationMs : max),
    undefined,
  );
}

/**
 * Sorts, clamps to `[0, durationMs]` and merges overlapping (or touching)
 * ranges. A range that collapses to empty after clamping is dropped. The
 * surviving id of a merged run is the first range's, in sorted order.
 */
export function normaliseProtectedRanges(
  ranges: readonly { id: string; s: number; e: number }[],
  durationMs: number | undefined,
): ProtectedRange[] {
  const clamped = ranges
    .map((range) => ({
      id: range.id,
      s: Math.max(0, range.s),
      e: durationMs === undefined ? range.e : Math.min(range.e, durationMs),
    }))
    .filter((range) => range.s < range.e)
    .sort((a, b) => a.s - b.s || a.e - b.e);

  const merged: ProtectedRange[] = [];
  for (const range of clamped) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.s <= last.e) {
      if (range.e > last.e) merged[merged.length - 1] = { ...last, e: range.e };
      continue;
    }
    merged.push({ id: range.id, s: range.s, e: range.e, reason: "user" });
  }
  return merged;
}

function applySetProtectedRanges(draft: EdgDraft, op: SetProtectedRangesOp): void {
  for (const range of op.ranges) {
    if (range.s >= range.e) {
      fail("invalid-range", `range ${range.id} has s ${range.s} >= e ${range.e}`);
    }
  }
  const protectedRanges = normaliseProtectedRanges(op.ranges, mediaDurationMs(draft));
  draft.hot = { ...draft.hot, protected: protectedRanges };
}

function applyResegment(draft: EdgDraft, op: ResegmentOp, ctx: ApplyContext): void {
  if (draft.words.size === 0) fail("invariant", "Resegment needs the transcript to be loaded");
  const words = draftLiveWords(draft);
  const previous = draft.order.map((id) => draft.segments.get(id)).filter(isSegment);
  const created = segmentWords(
    words,
    {
      ...ctx.segmenter,
      maxChars: op.maxChars,
      maxLines: op.maxLines,
      minMs: op.minMs,
      maxMs: op.maxMs,
    },
    { newId: ctx.newId ?? defaultNewId, dropFillers: ctx.dropFillers === true },
  );

  const ranges = previous.map((segment) => ({
    segment,
    from: positionOf(draft, segment.startWordId) ?? 0,
    to: positionOf(draft, segment.endWordId) ?? -1,
  }));
  const emphasis = previous.flatMap((segment) => segment.emphasis ?? []);

  const rebuilt = created.map((segment) => {
    const from = positionOf(draft, segment.startWordId) ?? 0;
    const to = positionOf(draft, segment.endWordId) ?? -1;
    const length = to - from + 1;
    let best: Segment | undefined;
    let bestOverlap = 0;
    for (const range of ranges) {
      const overlap = Math.min(to, range.to) - Math.max(from, range.from) + 1;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = range.segment;
      }
    }
    const inherited = length > 0 && bestOverlap / length >= 0.5 ? best : undefined;
    return {
      ...segment,
      styleRef: segment.styleRef ?? inherited?.styleRef,
      overrides: inherited?.overrides,
      position: inherited?.position,
      hidden: inherited?.hidden,
      emphasis: emphasisWithin(draft, emphasis, from, to),
    } satisfies Segment;
  });

  for (const segment of previous) removeSegment(draft, segment.id);
  for (const segment of rebuilt) putSegment(draft, segment);

  // The client's "reflow available" banner (apps/web's `checkReflow`,
  // lib/edg/caption-budgets.ts) compares the *current* style's fit budget
  // against what `meta.engineVersions.captionBudgets` says the document was
  // last segmented with. Without updating that record here, a Resegment
  // that used exactly the offered budget would still look stale forever —
  // the banner never clears, because nothing else ever rewrites this key
  // after `initialise` sets it. `op.maxChars`/`op.maxLines` *are* the budget
  // this resegment just cut to, so they are what gets recorded; every other
  // field of the stored shape (script/aspect/styleRef/canvas/source) carries
  // over unchanged since a Resegment does not change the style or canvas.
  const previousBudgets = parseStoredCaptionBudgets(draft.hot.meta.engineVersions);
  if (previousBudgets !== undefined) {
    const updated: Record<string, unknown> = {
      ...previousBudgets,
      maxChars: op.maxChars,
      maxLines: op.maxLines,
    };
    draft.hot = {
      ...draft.hot,
      meta: {
        ...draft.hot.meta,
        engineVersions: {
          ...draft.hot.meta.engineVersions,
          captionBudgets: JSON.stringify(updated),
        },
      },
    };
  }
}

/** Mirrors `apps/web/lib/edg/caption-budgets.ts`'s parser without importing app code into the engine package. */
function parseStoredCaptionBudgets(
  engineVersions: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> | undefined {
  const raw = engineVersions?.["captionBudgets"];
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function isSegment(segment: Segment | undefined): segment is Segment {
  return segment !== undefined;
}

function applyDecideItems(draft: EdgDraft, op: DecideItemsOp): void {
  const items = op.itemIds.map((itemId) => {
    const item = draft.items.get(itemId);
    if (item === undefined) {
      fail(
        draft.tombstones.has(itemId) ? "stale" : "unknown-id",
        `pass item ${itemId} is not in the document`,
      );
    }
    return item;
  });
  for (const item of items) draft.items.set(item.itemId, { ...item, state: op.state });
}

function applyMergePass(draft: EdgDraft, op: MergePassOp, ctx: ApplyContext): void {
  if ((ctx.source ?? "web") !== "worker") {
    fail("forbidden", "MergePass may only be submitted by a worker");
  }
  const { items, ...record } = op.pass;
  if (draft.tombstones.has(record.passId)) fail("stale", `pass ${record.passId} was deleted`);
  if (draft.passes.has(record.passId)) return;
  for (const item of items) {
    if (item.passId !== record.passId) {
      fail("invalid", `item ${item.itemId} claims pass ${item.passId}`);
    }
    if (draft.items.has(item.itemId) || draft.tombstones.has(item.itemId)) {
      fail("invariant", `pass item id ${item.itemId} is already in use`);
    }
  }
  draft.passes.set(record.passId, record);
  for (const item of items) draft.items.set(item.itemId, item);
}

function applySetAudio(draft: EdgDraft, op: SetAudioOp): void {
  if (op.clean === undefined && op.ducking === undefined) {
    fail("invalid", "SetAudio carries neither clean nor ducking");
  }
  const audio = { ...draft.hot.audio };
  if (op.clean !== undefined) audio["clean"] = op.clean;
  if (op.ducking !== undefined) audio["ducking"] = op.ducking;
  draft.hot = { ...draft.hot, audio };
}

function applySetRender(draft: EdgDraft, op: SetRenderOp): void {
  if (op.presets === undefined) return;
  draft.hot = { ...draft.hot, render: { ...draft.hot.render, presets: op.presets } };
}

function dispatch(draft: EdgDraft, op: EdgOp, ctx: ApplyContext): void {
  switch (op.type) {
    case "SetSegmentText":
      return applySetSegmentText(draft, op);
    case "SetSegmentBounds":
      return applySetSegmentBounds(draft, op);
    case "SplitSegment":
      return applySplitSegment(draft, op);
    case "MergeSegments":
      return applyMergeSegments(draft, op);
    case "SetEmphasis":
      return applySetEmphasis(draft, op);
    case "SetSegmentPosition":
      return applySetSegmentPosition(draft, op);
    case "HideSegment":
      return applyHideSegment(draft, op);
    case "SetStyle":
      return applySetStyle(draft, op);
    case "EditWord":
      return applyEditWord(draft, op);
    case "DeleteWord":
      return applyDeleteWord(draft, op);
    case "InsertWordAfter":
      return applyInsertWordAfter(draft, op);
    case "SetProtectedRanges":
      return applySetProtectedRanges(draft, op);
    case "SetWordTiming":
      return applySetWordTiming(draft, op);
    case "Resegment":
      return applyResegment(draft, op, ctx);
    case "DecideItems":
      return applyDecideItems(draft, op);
    case "MergePass":
      return applyMergePass(draft, op, ctx);
    case "SetAudio":
      return applySetAudio(draft, op);
    case "SetRender":
      return applySetRender(draft, op);
    default: {
      const exhaustive: never = op;
      throw new Error(`unhandled op ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Applies `ops` to `state` in order.
 *
 * An `opId` already inside the idempotency window is reported as applied without
 * touching the document, so a client that retries a batch after a dropped
 * response gets the same answer instead of a double edit.
 */
export function applyOps(
  state: EdgState,
  ops: readonly EdgOp[],
  ctx: ApplyContext = {},
): ApplyResult {
  const draft = toDraft(state);
  const applied: string[] = [];
  const skipped: string[] = [];
  const rejected: OpRejection[] = [];
  let changed = false;

  for (const op of ops) {
    if (draft.appliedOpIds.has(op.opId)) {
      applied.push(op.opId);
      skipped.push(op.opId);
      continue;
    }
    try {
      dispatch(draft, op, ctx);
      rememberOpId(draft, op.opId);
      applied.push(op.opId);
      changed = true;
    } catch (error: unknown) {
      if (!(error instanceof OpRejectedError)) throw error;
      rejected.push({ opId: op.opId, reason: error.reason, message: error.detail.slice(0, 500) });
    }
  }

  if (changed && ctx.revision !== undefined) {
    draft.hot = { ...draft.hot, meta: { ...draft.hot.meta, revision: ctx.revision } };
  }

  return { state: fromDraft(draft), applied, rejected, skipped };
}
