import { encodeUlidTime, makeWordId, type WordId } from "./ids.js";
import { EDG_SCHEMA_VERSION, type EdgProjection } from "./schemas/document.js";
import { type Segment } from "./schemas/segment.js";
import { type TranscriptChunk, type Word } from "./schemas/transcript.js";
import { seqSequence } from "./seq.js";

/**
 * Deterministic builders for the tests in this package. Not part of the public
 * API: excluded from the build and from coverage, and never exported from
 * `src/index.ts`.
 */

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A counter-based ULID factory. Real ULIDs carry a clock and 80 random bits; a
 * test that has to assert on ids needs them to be reproducible instead.
 */
export function idFactory(seed = 1): () => string {
  let counter = seed;
  return () => {
    const value = counter;
    counter += 1;
    let random = "";
    let remaining = value;
    for (let index = 0; index < 16; index += 1) {
      random = ULID_ALPHABET.charAt(remaining % 32) + random;
      remaining = Math.floor(remaining / 32);
    }
    return encodeUlidTime(value) + random;
  };
}

export interface WordSpec {
  t: string;
  s?: number;
  e?: number;
  sp?: string;
  filler?: boolean;
  deleted?: boolean;
}

export interface FixtureOptions {
  /** One word per entry, in document order. */
  words?: readonly WordSpec[];
  /** Words per segment; the last segment takes the remainder. */
  wordsPerSegment?: number;
  /** Milliseconds a generated word occupies. */
  wordMs?: number;
  /** Silence between generated words. */
  gapMs?: number;
  /** Chunk the words are stored in. */
  chunkIdx?: number;
}

export interface Fixture {
  projection: EdgProjection;
  chunks: TranscriptChunk[];
  words: Word[];
  segments: Segment[];
  wordIds: WordId[];
  segmentIds: string[];
  nextId: () => string;
}

const DEFAULT_WORDS: readonly WordSpec[] = [
  { t: "Bhai", sp: "sp1" },
  { t: "aaj", sp: "sp1" },
  { t: "hum", sp: "sp1" },
  { t: "baat", sp: "sp1" },
  { t: "karenge", sp: "sp1" },
  { t: "video", sp: "sp1" },
  { t: "editing", sp: "sp1" },
  { t: "ke", sp: "sp1" },
  { t: "bare", sp: "sp1" },
  { t: "mein.", sp: "sp1" },
  { t: "Haan", sp: "sp2" },
  { t: "bilkul.", sp: "sp2" },
];

/**
 * A small, fully valid projection plus the transcript it addresses: 12 Hinglish
 * words in one chunk, grouped into segments of four.
 */
export function buildFixture(options: FixtureOptions = {}): Fixture {
  const specs = options.words ?? DEFAULT_WORDS;
  const wordMs = options.wordMs ?? 450;
  const gapMs = options.gapMs ?? 50;
  const chunkIdx = options.chunkIdx ?? 0;
  const perSegment = options.wordsPerSegment ?? 4;
  const nextId = idFactory();

  const words: Word[] = specs.map((spec, index) => {
    const start = spec.s ?? index * (wordMs + gapMs);
    const word: Word = {
      wid: makeWordId(chunkIdx, index),
      s: start,
      e: spec.e ?? start + wordMs,
      t: spec.t,
    };
    if (spec.sp !== undefined) word.sp = spec.sp;
    if (spec.filler !== undefined) word.filler = spec.filler;
    if (spec.deleted !== undefined) word.deleted = spec.deleted;
    return word;
  });

  const groups: Word[][] = [];
  for (let index = 0; index < words.length; index += perSegment) {
    groups.push(words.slice(index, index + perSegment));
  }
  const keys = seqSequence(groups.length);
  const segments: Segment[] = groups.map((group, index) => {
    const first = group[0];
    const last = group[group.length - 1];
    const seq = keys[index];
    if (first === undefined || last === undefined || seq === undefined) {
      throw new Error("fixture built an empty segment");
    }
    return {
      id: nextId(),
      seq,
      startWordId: first.wid,
      endWordId: last.wid,
      startMs: first.s,
      endMs: last.e,
    };
  });

  const lastWord = words[words.length - 1];
  const chunks: TranscriptChunk[] = [
    { chunkIdx, startMs: 0, endMs: lastWord === undefined ? 0 : lastWord.e, words },
  ];

  const projection: EdgProjection = {
    meta: {
      edgId: nextId(),
      projectId: nextId(),
      revision: 7,
      schemaVersion: EDG_SCHEMA_VERSION,
    },
    media: [{ mediaId: nextId(), role: "primary", durationMs: 90_000, fps: 30 }],
    transcript: {
      transcriptId: nextId(),
      revision: 3,
      language: "hi-Latn",
      scripts: ["roman", "native", "en"],
      speakers: [
        { id: "sp1", name: "Aarav" },
        { id: "sp2", name: "Priya" },
      ],
    },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
    segments,
    passes: [],
  };

  return {
    projection,
    chunks,
    words,
    segments,
    wordIds: words.map((word) => word.wid),
    segmentIds: segments.map((segment) => segment.id),
    nextId,
  };
}
