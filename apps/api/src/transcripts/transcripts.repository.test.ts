import { describe, expect, it } from "vitest";

import type { Word } from "@montaj/edg/schemas";

import { nextWordSeqOf } from "./transcripts.repository.js";

import type { IngestChunk } from "./transcripts.repository.js";

function chunk(wids: readonly string[], nextWordSeq?: number): IngestChunk {
  return {
    chunkIdx: 0,
    startMs: 0,
    endMs: 1_000,
    ...(nextWordSeq === undefined ? {} : { nextWordSeq }),
    words: wids.map((wid, index) => ({
      wid: wid as Word["wid"],
      s: index * 100,
      e: index * 100 + 90,
      t: `w${String(index)}`,
    })),
  };
}

/**
 * `transcript_chunks.next_word_seq` is where A12 allocates new word ids from, and
 * ids are **never reused** (06 invariant 4). Every rule below exists so a number
 * that has already been issued can never be handed out a second time.
 */
describe("nextWordSeqOf", () => {
  it("is the word count for a dense, untouched chunk", () => {
    expect(nextWordSeqOf(chunk(["0:0", "0:1", "0:2"]))).toBe(3);
  });

  it("counts ids ISSUED, not words alive: a tombstone still spent its id", () => {
    // Post-processing folds `ek lakh` into one word and tombstones the other; the
    // live count is 1, but `0:1` has been issued and must never come back.
    const folded = chunk(["0:0", "0:1"]);
    expect(nextWordSeqOf({ ...folded, words: [folded.words[0] as Word] })).toBe(1);
    expect(nextWordSeqOf(folded)).toBe(2);
  });

  it("never falls below the highest id the chunk actually carries", () => {
    // A11 writes dense ids, but A12 inserts words at ids past the end.
    expect(nextWordSeqOf(chunk(["0:0", "0:7"]))).toBe(8);
  });

  it("never falls below what the worker says it already allocated", () => {
    // The worker dropped empty words after numbering, so its counter is ahead.
    expect(nextWordSeqOf(chunk(["0:0", "0:1"], 9))).toBe(9);
  });

  it("is 0 for an empty chunk", () => {
    expect(nextWordSeqOf(chunk([]))).toBe(0);
  });

  it("ignores a malformed id rather than trusting it", () => {
    expect(nextWordSeqOf(chunk(["0:0", "0:x"] as string[]))).toBe(2);
  });
});
