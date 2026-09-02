import { describe, expect, it } from "vitest";

import { makeWordId, type WordId } from "../ids.js";
import { EDG_SCHEMA_VERSION, type EdgProjection } from "../schemas/document.js";
import { type EdgOp } from "../schemas/ops.js";
import { type Segment } from "../schemas/segment.js";
import { type TranscriptChunk, type Word } from "../schemas/transcript.js";
import { segmentWords } from "../segmenter/segmenter.js";
import { seqSequence } from "../seq.js";
import { idFactory } from "../testing.js";
import { applyOps } from "./apply.js";
import { fromProjection } from "./state.js";

/**
 * The budgets from the A02b brief: a 1,000-op batch on a 9,000-segment document
 * in under 200 ms, and the segmenter over 54,000 words in under 500 ms — a
 * six-hour interview, the largest document the product promises to open.
 *
 * The assertion carries a slack factor because a shared CI runner is nothing
 * like a workstation; the measured time is printed either way, so a regression
 * shows up in the log long before it trips the gate.
 */

const SEGMENT_COUNT = 9_000;
const WORDS_PER_SEGMENT = 6;
const WORD_COUNT = SEGMENT_COUNT * WORDS_PER_SEGMENT;
const WORDS_PER_CHUNK = 6_000;
const SLACK = 5;

const VOCABULARY = ["bhai", "aaj", "hum", "video", "editing", "karenge", "timeline", "caption"];

function buildWords(): Word[] {
  const words: Word[] = new Array<Word>(WORD_COUNT);
  for (let index = 0; index < WORD_COUNT; index += 1) {
    const chunkIdx = Math.floor(index / WORDS_PER_CHUNK);
    const start = index * 400;
    words[index] = {
      wid: makeWordId(chunkIdx, index % WORDS_PER_CHUNK),
      s: start,
      e: start + 320,
      t: VOCABULARY[index % VOCABULARY.length] ?? "word",
      sp: index % 97 === 0 ? "sp2" : "sp1",
    };
  }
  return words;
}

function buildChunks(words: readonly Word[]): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  for (let from = 0; from < words.length; from += WORDS_PER_CHUNK) {
    const slice = words.slice(from, from + WORDS_PER_CHUNK);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (first === undefined || last === undefined) continue;
    chunks.push({
      chunkIdx: Math.floor(from / WORDS_PER_CHUNK),
      startMs: first.s,
      endMs: last.e,
      words: slice,
    });
  }
  return chunks;
}

function buildProjection(words: readonly Word[], mint: () => string): EdgProjection {
  const keys = seqSequence(SEGMENT_COUNT);
  const segments: Segment[] = [];
  for (let index = 0; index < SEGMENT_COUNT; index += 1) {
    const first = words[index * WORDS_PER_SEGMENT];
    const last = words[index * WORDS_PER_SEGMENT + WORDS_PER_SEGMENT - 1];
    const seq = keys[index];
    if (first === undefined || last === undefined || seq === undefined) break;
    segments.push({
      id: mint(),
      seq,
      startWordId: first.wid,
      endWordId: last.wid,
      startMs: first.s,
      endMs: last.e,
    });
  }
  return {
    meta: { edgId: mint(), projectId: mint(), revision: 1, schemaVersion: EDG_SCHEMA_VERSION },
    media: [{ mediaId: mint(), role: "primary", durationMs: WORD_COUNT * 400 }],
    transcript: { transcriptId: mint(), revision: 1, language: "hi-Latn", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
    segments,
    passes: [],
  };
}

/** A realistic batch: mostly caption edits, with a few structural ops. */
function buildBatch(segments: readonly Segment[], words: readonly Word[], mint: () => string) {
  const ops: EdgOp[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const segment = segments[(index * 7) % segments.length];
    if (segment === undefined) continue;
    const wordId = segment.startWordId;
    switch (index % 10) {
      case 0:
        ops.push({ opId: mint(), type: "HideSegment", segmentId: segment.id, hidden: true });
        break;
      case 1:
      case 2:
        ops.push({
          opId: mint(),
          type: "SetSegmentText",
          segmentId: segment.id,
          script: "en",
          text: `line ${String(index)}`,
        });
        break;
      case 3:
        ops.push({
          opId: mint(),
          type: "SetEmphasis",
          segmentId: segment.id,
          wordId,
          presetId: "pop",
        });
        break;
      case 4:
        ops.push({
          opId: mint(),
          type: "SetSegmentBounds",
          segmentId: segment.id,
          startMs: segment.startMs,
          endMs: segment.endMs,
        });
        break;
      case 5:
        ops.push({
          opId: mint(),
          type: "SetStyle",
          scope: "segment",
          segmentId: segment.id,
          styleRef: "clean-caption",
        });
        break;
      case 6:
        ops.push({
          opId: mint(),
          type: "SplitSegment",
          segmentId: segment.id,
          atWordId: (words[(index * 7 * WORDS_PER_SEGMENT + 3) % words.length]?.wid ??
            wordId) as WordId,
          newSegmentId: mint(),
        });
        break;
      case 7:
        ops.push({ opId: mint(), type: "EditWord", wordId, text: `edit${String(index)}` });
        break;
      case 8:
        ops.push({
          opId: mint(),
          type: "SetSegmentPosition",
          segmentId: segment.id,
          position: { x: 0.5, y: 0.8, anchor: "bottom-center" },
        });
        break;
      default:
        ops.push({ opId: mint(), type: "DeleteWord", wordId: segment.endWordId });
        break;
    }
  }
  return ops;
}

/** Fastest of a few runs: enough to shake off a cold JIT without hiding a regression. */
function fastest(runs: number, work: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    work();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("performance", () => {
  const mint = idFactory(4_000_000);
  const words = buildWords();
  const chunks = buildChunks(words);
  const projection = buildProjection(words, mint);
  const state = fromProjection(projection, { chunks });
  const batch = buildBatch(projection.segments, words, mint);

  it(`applies 1,000 ops to ${String(SEGMENT_COUNT)} segments well inside 200 ms`, () => {
    expect(state.segments.size).toBe(SEGMENT_COUNT);
    expect(state.words.size).toBe(WORD_COUNT);
    const elapsed = fastest(3, () => {
      const result = applyOps(state, batch, { source: "worker" });
      expect(result.applied.length).toBeGreaterThan(900);
    });
    console.log(
      `applyOps: 1,000 ops on ${String(SEGMENT_COUNT)} segments in ${elapsed.toFixed(1)} ms`,
    );
    expect(elapsed).toBeLessThan(200 * SLACK);
  }, 120_000);

  it(`segments ${String(WORD_COUNT)} words well inside 500 ms`, () => {
    let produced = 0;
    const mintSegment = idFactory(5_000_000);
    const elapsed = fastest(3, () => {
      produced = segmentWords(words, {}, { newId: mintSegment }).length;
    });
    console.log(
      `segmentWords: ${String(WORD_COUNT)} words into ${String(produced)} segments in ${elapsed.toFixed(1)} ms`,
    );
    expect(produced).toBeGreaterThan(1_000);
    expect(elapsed).toBeLessThan(500 * SLACK);
  }, 120_000);
});
