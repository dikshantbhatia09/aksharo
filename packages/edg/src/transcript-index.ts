import { isWordId, type WordId } from "./ids.js";
import { type TranscriptChunk, type Word } from "./schemas/transcript.js";

/**
 * Transcript lookup: the chunked storage of D28 flattened into one addressable
 * word list. Everything that resolves a `WordId` — segment bounds, emphasis,
 * `wordsBetween` — goes through this index instead of re-scanning chunks.
 */

/** A word plus where it sits: its chunk, and its start relative to that chunk. */
export interface IndexedWord extends Word {
  /** Chunk that stores the word; always the `<chunkIdx>` half of `wid`. */
  chunkIdx: number;
  /** `s` relative to the chunk's `startMs`, for chunk-local rendering. */
  offsetMs: number;
}

/**
 * Word id → word, in **document order**: chunks ascending by `chunkIdx`, words in
 * array order inside a chunk. A `Map` preserves insertion order, so iteration
 * order is the reading order — which matters because `InsertWordAfter` allocates
 * a higher `n` for a word that sits in the middle of a chunk (D28), so numeric
 * id order is *not* document order.
 */
export type WordIndex = Map<WordId, IndexedWord>;

/** Thrown when the transcript is not addressable: duplicate or unknown word ids. */
export class TranscriptIndexError extends Error {
  override readonly name = "TranscriptIndexError";
}

/**
 * Builds the word index from transcript chunks. Chunks may arrive in any order;
 * they are sorted by `chunkIdx` first. Duplicate word ids throw — ids are
 * allocated once and never reused.
 */
export function buildWordIndex(chunks: readonly TranscriptChunk[]): WordIndex {
  const index: WordIndex = new Map();
  const ordered = [...chunks].sort((a, b) => a.chunkIdx - b.chunkIdx);
  for (const chunk of ordered) {
    for (const word of chunk.words) {
      if (index.has(word.wid)) {
        throw new TranscriptIndexError(`duplicate word id ${word.wid}`);
      }
      index.set(word.wid, { ...word, chunkIdx: chunk.chunkIdx, offsetMs: word.s - chunk.startMs });
    }
  }
  return index;
}

/** Document position of every word id, `0`-based. */
export function wordPositions(index: WordIndex): Map<WordId, number> {
  const positions = new Map<WordId, number>();
  let position = 0;
  for (const wordId of index.keys()) {
    positions.set(wordId, position);
    position += 1;
  }
  return positions;
}

export interface WordsBetweenOptions {
  /** Keep tombstoned words in the result. Default `false` — deleted words never render. */
  includeDeleted?: boolean;
}

/**
 * The words from `startWordId` to `endWordId` inclusive, in document order.
 * Throws when either id is unknown or when the range runs backwards, so a
 * corrupt segment fails loudly instead of rendering an empty caption.
 */
export function wordsBetween(
  index: WordIndex,
  startWordId: string,
  endWordId: string,
  options: WordsBetweenOptions = {},
): IndexedWord[] {
  const positions = wordPositions(index);
  const start = isWordId(startWordId) ? positions.get(startWordId) : undefined;
  const end = isWordId(endWordId) ? positions.get(endWordId) : undefined;
  if (start === undefined)
    throw new TranscriptIndexError(`unknown word id ${JSON.stringify(startWordId)}`);
  if (end === undefined)
    throw new TranscriptIndexError(`unknown word id ${JSON.stringify(endWordId)}`);
  if (start > end) {
    throw new TranscriptIndexError(
      `word range runs backwards: ${startWordId} is after ${endWordId}`,
    );
  }

  const words: IndexedWord[] = [];
  let position = 0;
  for (const word of index.values()) {
    if (
      position >= start &&
      position <= end &&
      (options.includeDeleted === true || word.deleted !== true)
    ) {
      words.push(word);
    }
    position += 1;
    if (position > end) break;
  }
  return words;
}
