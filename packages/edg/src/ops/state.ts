import { type WordId, parseWordId } from "../ids.js";
import { type EdgHot, type EdgProjection } from "../schemas/document.js";
import { type Pass, type PassItem } from "../schemas/pass.js";
import { type Segment } from "../schemas/segment.js";
import { type TranscriptChunk, type Word } from "../schemas/transcript.js";
import { compareSeqKeys } from "../seq.js";
import { buildWordIndex, type IndexedWord, type WordIndex } from "../transcript-index.js";

/**
 * The in-memory EDG state the ops engine works on: the hot document, the segment
 * and pass rows keyed by id, the transcript word index, and the tombstones that
 * make an op against a dead id `stale` instead of resurrecting it.
 *
 * It is **pure data**. Nothing here reads a database — the API module (A12) and
 * the browser client both build a state, apply ops to it and write the result
 * back, which is what makes the two agree about what an op means.
 *
 * Every state value is treated as immutable: `applyOps` builds a private draft,
 * mutates that, and returns a new state that shares everything the batch did not
 * touch.
 */

/**
 * A pass without its items. Items live exactly once, in `EdgState.items`, so a
 * `DecideItems` op can never leave two copies of the same proposal disagreeing;
 * `toProjection` nests them back under their pass.
 */
export type PassRecord = Omit<Pass, "items">;

/** Declared bounds of a transcript chunk, kept so chunks round-trip exactly. */
export interface ChunkBounds {
  readonly startMs: number;
  readonly endMs: number;
}

/** How many `opId`s the idempotency window remembers (oldest evicted first). */
export const APPLIED_OP_ID_LIMIT = 10_000;

export interface EdgState {
  /** The small hot document (`edg_documents.doc`). */
  readonly hot: EdgHot;
  /** Live segments by id. */
  readonly segments: ReadonlyMap<string, Segment>;
  /** Segment ids in `seq` order — the order captions render in. */
  readonly segmentOrder: readonly string[];
  /** Passes by id, without their items. */
  readonly passes: ReadonlyMap<string, PassRecord>;
  /** Pass items by id, across every pass. */
  readonly items: ReadonlyMap<string, PassItem>;
  /** The transcript, in document order (`@montaj/edg/transcript-index`). */
  readonly words: WordIndex;
  /** Declared bounds of every transcript chunk, by `chunkIdx`. */
  readonly chunks: ReadonlyMap<number, ChunkBounds>;
  /** Segment, item and word ids that are gone for good. Ids are never reused. */
  readonly tombstones: ReadonlySet<string>;
  /** The last {@link APPLIED_OP_ID_LIMIT} accepted `opId`s, oldest first. */
  readonly appliedOpIds: ReadonlySet<string>;
}

/** Thrown when the state itself is inconsistent — a bug, never bad input. */
export class EdgStateError extends Error {
  override readonly name = "EdgStateError";
}

export interface FromProjectionOptions {
  /** Transcript chunks; the words segments address. */
  chunks?: readonly TranscriptChunk[];
  /** A prebuilt word index, when the caller already has one. */
  wordIndex?: WordIndex;
  /** Bounds for a state built from a `wordIndex` rather than from chunks. */
  chunkBounds?: ReadonlyMap<number, ChunkBounds>;
  /** Ids already known to be dead (a restored snapshot carries them). */
  tombstones?: Iterable<string>;
  /** The idempotency window as it stood, oldest first. */
  appliedOpIds?: Iterable<string>;
}

function boundsFromChunks(chunks: readonly TranscriptChunk[]): Map<number, ChunkBounds> {
  const bounds = new Map<number, ChunkBounds>();
  for (const chunk of chunks) {
    bounds.set(chunk.chunkIdx, { startMs: chunk.startMs, endMs: chunk.endMs });
  }
  return bounds;
}

/** Derives chunk bounds from an index alone: the span its words cover. */
function boundsFromIndex(index: WordIndex): Map<number, ChunkBounds> {
  const bounds = new Map<number, ChunkBounds>();
  for (const word of index.values()) {
    const start = word.s - word.offsetMs;
    const existing = bounds.get(word.chunkIdx);
    bounds.set(word.chunkIdx, {
      startMs: existing === undefined ? start : Math.min(existing.startMs, start),
      endMs: existing === undefined ? word.e : Math.max(existing.endMs, word.e),
    });
  }
  return bounds;
}

/** Keeps only the newest {@link APPLIED_OP_ID_LIMIT} ids of an ordered set. */
function boundedOpIds(opIds: Iterable<string>): Set<string> {
  const all = [...opIds];
  const window = all.length > APPLIED_OP_ID_LIMIT ? all.slice(-APPLIED_OP_ID_LIMIT) : all;
  return new Set(window);
}

/**
 * Builds a state from a stored projection. Word-addressed ops need the
 * transcript too: pass `chunks` (or a prebuilt `wordIndex`), or accept that ops
 * naming a word will be rejected as `unknown-id`.
 */
export function fromProjection(
  projection: EdgProjection,
  options: FromProjectionOptions = {},
): EdgState {
  const segments = new Map<string, Segment>();
  const ordered = [...projection.segments].sort((a, b) => compareSeqKeys(a.seq, b.seq));
  for (const segment of ordered) segments.set(segment.id, segment);

  const passes = new Map<string, PassRecord>();
  const items = new Map<string, PassItem>();
  for (const pass of projection.passes) {
    const { items: passItems, ...record } = pass;
    passes.set(pass.passId, record);
    for (const item of passItems) items.set(item.itemId, item);
  }

  const words =
    options.wordIndex ??
    (options.chunks === undefined ? new Map() : buildWordIndex(options.chunks));
  const chunks =
    options.chunks !== undefined
      ? boundsFromChunks(options.chunks)
      : (options.chunkBounds ?? boundsFromIndex(words));

  return {
    hot: {
      meta: projection.meta,
      media: projection.media,
      transcript: projection.transcript,
      canvas: projection.canvas,
      styles: projection.styles,
      ...(projection.audio === undefined ? {} : { audio: projection.audio }),
      ...(projection.render === undefined ? {} : { render: projection.render }),
      ...(projection.protected === undefined ? {} : { protected: projection.protected }),
    },
    segments,
    segmentOrder: ordered.map((segment) => segment.id),
    passes,
    items,
    words,
    chunks,
    tombstones: new Set(options.tombstones ?? []),
    appliedOpIds: boundedOpIds(options.appliedOpIds ?? []),
  };
}

/**
 * The projection a state stands for: segments in `seq` order, passes sorted by
 * `passId` and items by `(startMs, itemId)`.
 *
 * The sort is what makes the projection **canonical**: two clients that applied
 * the same commuting ops in different orders serialise byte-identical documents.
 */
export function toProjection(state: EdgState): EdgProjection {
  const itemsByPass = new Map<string, PassItem[]>();
  for (const item of state.items.values()) {
    const bucket = itemsByPass.get(item.passId);
    if (bucket === undefined) itemsByPass.set(item.passId, [item]);
    else bucket.push(item);
  }

  const passes = [...state.passes.values()]
    .sort((a, b) => (a.passId < b.passId ? -1 : a.passId > b.passId ? 1 : 0))
    .map((record) => ({
      ...record,
      items: (itemsByPass.get(record.passId) ?? []).sort(
        (a, b) => a.startMs - b.startMs || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
      ),
    }));

  const segments: Segment[] = [];
  for (const id of state.segmentOrder) {
    const segment = state.segments.get(id);
    if (segment === undefined) throw new EdgStateError(`segment order names a missing id ${id}`);
    segments.push(segment);
  }

  return { ...state.hot, segments, passes };
}

/** The transcript chunks a state stands for, ready to persist or snapshot. */
export function toTranscriptChunks(state: EdgState): TranscriptChunk[] {
  const byChunk = new Map<number, Word[]>();
  for (const indexed of state.words.values()) {
    const { chunkIdx, offsetMs: _offsetMs, ...word } = indexed;
    const bucket = byChunk.get(chunkIdx);
    if (bucket === undefined) byChunk.set(chunkIdx, [word]);
    else bucket.push(word);
  }
  return [...byChunk.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chunkIdx, words]) => {
      const bounds = state.chunks.get(chunkIdx);
      const first = words[0];
      const fallbackStart = first === undefined ? 0 : first.s;
      const fallbackEnd = words.reduce((end, word) => Math.max(end, word.e), fallbackStart);
      return {
        chunkIdx,
        startMs: bounds?.startMs ?? fallbackStart,
        endMs: bounds?.endMs ?? fallbackEnd,
        words,
      };
    });
}

/** Live (not tombstoned) words in document order — what the segmenter runs on. */
export function liveWords(state: EdgState): IndexedWord[] {
  const live: IndexedWord[] = [];
  for (const word of state.words.values()) {
    if (word.deleted !== true) live.push(word);
  }
  return live;
}

/** Segments in `seq` order. */
export function orderedSegments(state: EdgState): Segment[] {
  return state.segmentOrder.map((id) => {
    const segment = state.segments.get(id);
    if (segment === undefined) throw new EdgStateError(`segment order names a missing id ${id}`);
    return segment;
  });
}

/** `true` when the batch this `opId` belongs to has already been applied. */
export function hasAppliedOp(state: EdgState, opId: string): boolean {
  return state.appliedOpIds.has(opId);
}

/* -------------------------------------------------------------------------- */
/* Drafts — the mutable working copy `applyOps` builds and then freezes.        */
/* -------------------------------------------------------------------------- */

/**
 * A mutable working copy. Maps are copied once per batch, not once per op, and
 * the transcript is only copied when an op actually touches a word.
 *
 * @internal — exported for `applyOps` and its tests, not part of the package API.
 */
export interface EdgDraft {
  hot: EdgHot;
  segments: Map<string, Segment>;
  /** Segment ids kept sorted by `seq`. */
  order: string[];
  passes: Map<string, PassRecord>;
  items: Map<string, PassItem>;
  words: WordIndex;
  /** `true` once `words` is a private copy this draft may mutate. */
  wordsOwned: boolean;
  /** `true` once the word set changed and the index has to be re-ordered. */
  wordsChanged: boolean;
  /** Word ids in document order; built on first word access. */
  wordOrder: WordId[] | undefined;
  /**
   * Sort key per word. Fractional so `InsertWordAfter` is O(1): the new word
   * takes the midpoint of its neighbours instead of renumbering the transcript.
   */
  positions: Map<WordId, number> | undefined;
  /** Highest `n` allocated in each chunk, so a new word id can never collide. */
  maxWordSeq: Map<number, number> | undefined;
  /** Chunk start times, for the `offsetMs` of an inserted word. */
  chunkStarts: Map<number, number> | undefined;
  chunks: Map<number, ChunkBounds>;
  /** Word id → segments whose range starts or ends on it. */
  boundaries: Map<WordId, Set<string>>;
  tombstones: Set<string>;
  appliedOpIds: Set<string>;
}

function indexBoundaries(draft: EdgDraft, segment: Segment): void {
  for (const wordId of [segment.startWordId, segment.endWordId]) {
    const bucket = draft.boundaries.get(wordId);
    if (bucket === undefined) draft.boundaries.set(wordId, new Set([segment.id]));
    else bucket.add(segment.id);
  }
}

function unindexBoundaries(draft: EdgDraft, segment: Segment): void {
  for (const wordId of [segment.startWordId, segment.endWordId]) {
    const bucket = draft.boundaries.get(wordId);
    if (bucket === undefined) continue;
    bucket.delete(segment.id);
    if (bucket.size === 0) draft.boundaries.delete(wordId);
  }
}

/** @internal */
export function toDraft(state: EdgState): EdgDraft {
  const draft: EdgDraft = {
    hot: state.hot,
    segments: new Map(state.segments),
    order: [...state.segmentOrder],
    passes: new Map(state.passes),
    items: new Map(state.items),
    words: state.words,
    wordsOwned: false,
    wordsChanged: false,
    wordOrder: undefined,
    positions: undefined,
    maxWordSeq: undefined,
    chunkStarts: undefined,
    chunks: new Map(state.chunks),
    boundaries: new Map(),
    tombstones: new Set(state.tombstones),
    appliedOpIds: new Set(state.appliedOpIds),
  };
  for (const segment of draft.segments.values()) indexBoundaries(draft, segment);
  return draft;
}

/** @internal */
export function fromDraft(draft: EdgDraft): EdgState {
  let words = draft.words;
  if (draft.wordsChanged) {
    const order = wordOrderOf(draft);
    const reordered: WordIndex = new Map();
    for (const wordId of order) {
      const word = draft.words.get(wordId);
      if (word === undefined) throw new EdgStateError(`word order names a missing id ${wordId}`);
      reordered.set(wordId, word);
    }
    words = reordered;
  }
  return {
    hot: draft.hot,
    segments: draft.segments,
    segmentOrder: draft.order,
    passes: draft.passes,
    items: draft.items,
    words,
    chunks: draft.chunks,
    tombstones: draft.tombstones,
    appliedOpIds: draft.appliedOpIds,
  };
}

/** Remembers an `opId`, evicting the oldest once the window is full. @internal */
export function rememberOpId(draft: EdgDraft, opId: string): void {
  if (draft.appliedOpIds.has(opId)) return;
  draft.appliedOpIds.add(opId);
  while (draft.appliedOpIds.size > APPLIED_OP_ID_LIMIT) {
    const oldest = draft.appliedOpIds.values().next();
    if (oldest.done === true) break;
    draft.appliedOpIds.delete(oldest.value);
  }
}

/* ------------------------------- segments -------------------------------- */

function seqAt(draft: EdgDraft, index: number): string {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const id = draft.order[index];
  if (id === undefined) throw new EdgStateError(`segment order has no entry at ${index}`);
  const segment = draft.segments.get(id);
  if (segment === undefined) throw new EdgStateError(`segment order names a missing id ${id}`);
  return segment.seq;
}

/** First index whose `seq` is greater than `seq`. */
function upperBound(draft: EdgDraft, seq: string): number {
  let low = 0;
  let high = draft.order.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareSeqKeys(seqAt(draft, middle), seq) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Position of `id` in `seq` order, or `-1`. @internal */
export function orderIndexOf(draft: EdgDraft, id: string, seq: string): number {
  const bound = upperBound(draft, seq);
  for (let index = bound - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (draft.order[index] === id) return index;
    if (compareSeqKeys(seqAt(draft, index), seq) !== 0) break;
  }
  return -1;
}

/**
 * Canonical form of a segment: optional fields that carry nothing are dropped,
 * and the keys always come out in the same order. Two states reached by the same
 * ops in a different order therefore serialise to the same bytes.
 */
export function pruneSegment(segment: Segment): Segment {
  const pruned: Segment = {
    id: segment.id,
    seq: segment.seq,
    startWordId: segment.startWordId,
    endWordId: segment.endWordId,
    startMs: segment.startMs,
    endMs: segment.endMs,
  };
  if (segment.styleRef !== undefined) pruned.styleRef = segment.styleRef;
  if (segment.textOverrides !== undefined && Object.keys(segment.textOverrides).length > 0) {
    pruned.textOverrides = segment.textOverrides;
  }
  if (segment.emphasis !== undefined && segment.emphasis.length > 0) {
    pruned.emphasis = segment.emphasis;
  }
  if (segment.position !== undefined) pruned.position = segment.position;
  if (segment.overrides !== undefined && Object.keys(segment.overrides).length > 0) {
    pruned.overrides = segment.overrides;
  }
  if (segment.hidden === true) pruned.hidden = true;
  return pruned;
}

/** Inserts or replaces a segment, keeping `order` and the boundary index true. @internal */
export function putSegment(draft: EdgDraft, incoming: Segment): void {
  const segment = pruneSegment(incoming);
  const previous = draft.segments.get(segment.id);
  draft.segments.set(segment.id, segment);
  if (previous === undefined) {
    draft.order.splice(upperBound(draft, segment.seq), 0, segment.id);
  } else {
    unindexBoundaries(draft, previous);
    if (previous.seq !== segment.seq) {
      const at = orderIndexOf(draft, segment.id, previous.seq);
      if (at >= 0) draft.order.splice(at, 1);
      draft.order.splice(upperBound(draft, segment.seq), 0, segment.id);
    }
  }
  indexBoundaries(draft, segment);
}

/** Removes a segment and tombstones its id. @internal */
export function removeSegment(draft: EdgDraft, id: string): void {
  const segment = draft.segments.get(id);
  if (segment === undefined) return;
  unindexBoundaries(draft, segment);
  const at = orderIndexOf(draft, id, segment.seq);
  if (at >= 0) draft.order.splice(at, 1);
  draft.segments.delete(id);
  draft.tombstones.add(id);
}

/** Segments whose range starts or ends on `wordId`. @internal */
export function segmentsOnBoundary(draft: EdgDraft, wordId: WordId): string[] {
  return [...(draft.boundaries.get(wordId) ?? [])];
}

/* --------------------------------- words --------------------------------- */

/** Word ids in document order, built on demand. @internal */
export function wordOrderOf(draft: EdgDraft): WordId[] {
  if (draft.wordOrder === undefined) draft.wordOrder = [...draft.words.keys()];
  return draft.wordOrder;
}

/** Sort key per word id, built on demand. @internal */
export function positionsOf(draft: EdgDraft): Map<WordId, number> {
  if (draft.positions === undefined) {
    const positions = new Map<WordId, number>();
    let index = 0;
    for (const wordId of wordOrderOf(draft)) {
      positions.set(wordId, index);
      index += 1;
    }
    draft.positions = positions;
  }
  return draft.positions;
}

/** Sort key of one word, or `undefined` when it is not in the transcript. @internal */
export function positionOf(draft: EdgDraft, wordId: string): number | undefined {
  return positionsOf(draft).get(wordId as WordId);
}

/** Highest `n` used in each chunk, built on demand. @internal */
export function maxWordSeqOf(draft: EdgDraft): Map<number, number> {
  if (draft.maxWordSeq === undefined) {
    const highest = new Map<number, number>();
    for (const wordId of draft.words.keys()) {
      const { chunkIdx, n } = parseWordId(wordId);
      const current = highest.get(chunkIdx);
      if (current === undefined || n > current) highest.set(chunkIdx, n);
    }
    draft.maxWordSeq = highest;
  }
  return draft.maxWordSeq;
}

/** Start time of each chunk, built on demand. @internal */
export function chunkStartsOf(draft: EdgDraft): Map<number, number> {
  if (draft.chunkStarts === undefined) {
    const starts = new Map<number, number>();
    for (const [chunkIdx, bounds] of draft.chunks) starts.set(chunkIdx, bounds.startMs);
    for (const word of draft.words.values()) {
      if (!starts.has(word.chunkIdx)) starts.set(word.chunkIdx, word.s - word.offsetMs);
    }
    draft.chunkStarts = starts;
  }
  return draft.chunkStarts;
}

function ownWords(draft: EdgDraft): void {
  if (draft.wordsOwned) return;
  draft.words = new Map(draft.words);
  draft.wordsOwned = true;
}

/** Replaces one word in place — same id, same position. @internal */
export function putWord(draft: EdgDraft, word: IndexedWord): void {
  ownWords(draft);
  draft.words.set(word.wid, word);
}

/** Renumbers every position as an integer; the escape hatch when a gap runs out. */
function renumberPositions(draft: EdgDraft): Map<WordId, number> {
  const positions = new Map<WordId, number>();
  let index = 0;
  for (const wordId of wordOrderOf(draft)) {
    positions.set(wordId, index);
    index += 1;
  }
  draft.positions = positions;
  return positions;
}

/**
 * Inserts `word` immediately after `afterWordId` in document order. O(log n) for
 * the position plus one array splice; the transcript is never renumbered unless
 * the gap between two neighbours has run out of floating-point room.
 *
 * @internal
 */
export function insertWordAfter(draft: EdgDraft, afterWordId: WordId, word: IndexedWord): void {
  ownWords(draft);
  const order = wordOrderOf(draft);
  let positions = positionsOf(draft);
  const anchor = positions.get(afterWordId);
  if (anchor === undefined) throw new EdgStateError(`unknown anchor word ${afterWordId}`);

  let at = indexOfPosition(order, positions, anchor);
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  if (order[at] !== afterWordId) throw new EdgStateError(`word order lost ${afterWordId}`);
  let next = order[at + 1];
  let nextPosition = next === undefined ? anchor + 1 : (positions.get(next) ?? anchor + 1);
  let position = next === undefined ? anchor + 1 : (anchor + nextPosition) / 2;

  if (position <= anchor || position >= nextPosition) {
    positions = renumberPositions(draft);
    const renumberedAnchor = positions.get(afterWordId);
    if (renumberedAnchor === undefined) throw new EdgStateError(`unknown anchor ${afterWordId}`);
    at = indexOfPosition(order, positions, renumberedAnchor);
    next = order[at + 1];
    nextPosition = next === undefined ? renumberedAnchor + 1 : (positions.get(next) ?? 0);
    position = next === undefined ? renumberedAnchor + 1 : (renumberedAnchor + nextPosition) / 2;
  }

  order.splice(at + 1, 0, word.wid);
  positions.set(word.wid, position);
  draft.words.set(word.wid, word);
  draft.wordsChanged = true;

  const highest = maxWordSeqOf(draft);
  const { chunkIdx, n } = parseWordId(word.wid);
  const current = highest.get(chunkIdx);
  if (current === undefined || n > current) highest.set(chunkIdx, n);
}

/** The live word before `position` but not before `floor`. @internal */
export function previousLiveWord(
  draft: EdgDraft,
  position: number,
  floor: number,
): IndexedWord | undefined {
  const order = wordOrderOf(draft);
  const positions = positionsOf(draft);
  for (let index = indexOfPosition(order, positions, position) - 1; index >= 0; index -= 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const wordId = order[index];
    if (wordId === undefined) break;
    const at = positions.get(wordId);
    if (at === undefined || at < floor) break;
    const word = draft.words.get(wordId);
    if (word !== undefined && word.deleted !== true) return word;
  }
  return undefined;
}

/** The live word after `position` but not after `ceiling`. @internal */
export function nextLiveWord(
  draft: EdgDraft,
  position: number,
  ceiling: number,
): IndexedWord | undefined {
  const order = wordOrderOf(draft);
  const positions = positionsOf(draft);
  for (
    let index = indexOfPosition(order, positions, position) + 1;
    index < order.length;
    index += 1
  ) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const wordId = order[index];
    if (wordId === undefined) break;
    const at = positions.get(wordId);
    if (at === undefined || at > ceiling) break;
    const word = draft.words.get(wordId);
    if (word !== undefined && word.deleted !== true) return word;
  }
  return undefined;
}

/** Binary search for the index holding `position` (the order is sorted by it). */
function indexOfPosition(
  order: readonly WordId[],
  positions: ReadonlyMap<WordId, number>,
  position: number,
): number {
  let low = 0;
  let high = order.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const wordId = order[middle];
    const at = wordId === undefined ? undefined : positions.get(wordId);
    if (at === undefined) break;
    if (at === position) return middle;
    if (at < position) low = middle + 1;
    else high = middle - 1;
  }
  return low - 1;
}

/** The word immediately after `wordId` in document order, deleted ones included. @internal */
export function wordAfter(draft: EdgDraft, wordId: string): IndexedWord | undefined {
  const positions = positionsOf(draft);
  const position = positions.get(wordId as WordId);
  if (position === undefined) return undefined;
  const order = wordOrderOf(draft);
  const nextId = order[indexOfPosition(order, positions, position) + 1];
  return nextId === undefined ? undefined : draft.words.get(nextId);
}

/** Live words of a draft, in document order. @internal */
export function draftLiveWords(draft: EdgDraft): IndexedWord[] {
  const words: IndexedWord[] = [];
  for (const wordId of wordOrderOf(draft)) {
    const word = draft.words.get(wordId);
    if (word !== undefined && word.deleted !== true) words.push(word);
  }
  return words;
}
