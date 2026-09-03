import { z } from "zod";

import { makeWordId, type WordId } from "../ids.js";
import { EDG_SCHEMA_VERSION, MediaRefSchema, SpeakerSchema } from "../schemas/document.js";
import { PassSchema } from "../schemas/pass.js";
import {
  AspectSchema,
  ConfidenceSchema,
  JsonObjectSchema,
  MsSchema,
  PresetIdSchema,
  ScriptIdSchema,
  StyleRefSchema,
  UlidSchema,
} from "../schemas/primitives.js";
import { PositionSchema } from "../schemas/segment.js";
import { type Segment } from "../schemas/segment.js";
import { type EdgSnapshot } from "../schemas/snapshot.js";
import { type TranscriptChunk, type Word, WordScriptsSchema } from "../schemas/transcript.js";
import { seqSequence } from "../seq.js";

/**
 * The v1 EDG and its migration to v2 (D28).
 *
 * v1 was one JSON document: the words lived inside it as a flat array and a
 * segment addressed them by **index** (`wordRange: [i, j]`, inclusive). That is
 * exactly what D28 replaced — an insert or a delete renumbered every segment
 * after it — so the migration's whole job is to hand every word the stable id
 * `"<chunkIdx>:<n>"` it will keep for ever and rewrite the ranges as ids.
 */

/** One 10-minute transcript chunk, the storage unit D28 introduced. */
export const CHUNK_MS = 600_000;

/** Thrown when a legacy document cannot be carried forward. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

const V1WordSchema = z.object({
  s: MsSchema,
  e: MsSchema,
  t: z.string(),
  c: ConfidenceSchema.optional(),
  sp: z.string().min(1).optional(),
  scripts: WordScriptsSchema.optional(),
  filler: z.boolean().optional(),
  deleted: z.boolean().optional(),
});

const V1EmphasisSchema = z.object({
  /** Index into the flat v1 word list. */
  wordIndex: z.number().int().min(0),
  presetId: PresetIdSchema,
});

const V1SegmentSchema = z.object({
  id: UlidSchema,
  /** Inclusive `[first, last]` indices into the flat v1 word list. */
  wordRange: z.tuple([z.number().int().min(0), z.number().int().min(0)]),
  startMs: MsSchema.optional(),
  endMs: MsSchema.optional(),
  styleRef: StyleRefSchema.optional(),
  /** v1 kept a single caption text; v2 keys it by script. */
  text: z.string().optional(),
  textOverrides: z.record(z.string(), z.string()).optional(),
  emphasis: z.array(V1EmphasisSchema).optional(),
  position: PositionSchema.optional(),
  overrides: JsonObjectSchema.optional(),
  hidden: z.boolean().optional(),
});

/** The whole v1 document, as `edg_snapshots.snapshot` stored it before D28. */
export const EdgV1DocumentSchema = z.object({
  schemaVersion: z.literal(1),
  meta: z.object({
    edgId: UlidSchema,
    projectId: UlidSchema,
    revision: z.number().int().min(0),
    engineVersions: z.record(z.string(), z.string()).optional(),
  }),
  media: z.array(MediaRefSchema),
  transcript: z.object({
    transcriptId: UlidSchema,
    revision: z.number().int().min(0),
    language: z.string().min(2).max(35),
    scripts: z.array(ScriptIdSchema).optional(),
    speakers: z.array(SpeakerSchema).optional(),
  }),
  canvas: z.object({
    aspect: AspectSchema,
    width: z.number().int().gt(0),
    height: z.number().int().gt(0),
    safeArea: JsonObjectSchema.optional(),
  }),
  styles: z.object({
    defaultStyleId: StyleRefSchema,
    inline: JsonObjectSchema.optional(),
    templateId: UlidSchema.optional(),
    brandKitId: UlidSchema.optional(),
  }),
  audio: JsonObjectSchema.optional(),
  render: JsonObjectSchema.optional(),
  /** Every word of the transcript, in document order. */
  words: z.array(V1WordSchema),
  /**
   * Words per stored chunk, in order. Cumulative counts give the chunk a word
   * belongs to; without it the migration falls back to 10-minute windows.
   */
  chunkSizes: z.array(z.number().int().min(0)).optional(),
  segments: z.array(V1SegmentSchema),
  passes: z.array(PassSchema).optional(),
});

export type EdgV1Document = z.infer<typeof EdgV1DocumentSchema>;

interface Allocated {
  readonly ids: WordId[];
  readonly chunks: TranscriptChunk[];
}

/** Chunk index per word, from the cumulative counts v1 stored. */
function chunkIndexesFromSizes(wordCount: number, chunkSizes: readonly number[]): number[] {
  const indexes: number[] = [];
  let chunkIdx = 0;
  let remaining = chunkSizes[0] ?? 0;
  for (let index = 0; index < wordCount; index += 1) {
    while (remaining <= 0 && chunkIdx < chunkSizes.length - 1) {
      chunkIdx += 1;
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      remaining = chunkSizes[chunkIdx] ?? 0;
    }
    if (remaining <= 0) {
      throw new MigrationError(
        `chunkSizes account for fewer words (${chunkSizes.reduce((a, b) => a + b, 0)}) than the document has (${wordCount})`,
      );
    }
    indexes.push(chunkIdx);
    remaining -= 1;
  }
  return indexes;
}

/** Hands every v1 word its stable id and packs the words back into chunks. */
function allocateWordIds(document: EdgV1Document): Allocated {
  const byTime = document.chunkSizes === undefined;
  const chunkIndexes = byTime
    ? document.words.map((word) => Math.floor(word.s / CHUNK_MS))
    : chunkIndexesFromSizes(document.words.length, document.chunkSizes ?? []);

  const ids: WordId[] = [];
  const grouped = new Map<number, Word[]>();
  const counters = new Map<number, number>();

  for (const [index, word] of document.words.entries()) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const chunkIdx = chunkIndexes[index] ?? 0;
    const n = counters.get(chunkIdx) ?? 0;
    counters.set(chunkIdx, n + 1);
    const wid = makeWordId(chunkIdx, n);
    ids.push(wid);
    const bucket = grouped.get(chunkIdx);
    const migrated: Word = { wid, s: word.s, e: word.e, t: word.t };
    if (word.c !== undefined) migrated.c = word.c;
    if (word.sp !== undefined) migrated.sp = word.sp;
    if (word.scripts !== undefined) migrated.scripts = word.scripts;
    if (word.filler !== undefined) migrated.filler = word.filler;
    if (word.deleted !== undefined) migrated.deleted = word.deleted;
    if (bucket === undefined) grouped.set(chunkIdx, [migrated]);
    else bucket.push(migrated);
  }

  const chunks = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chunkIdx, words]) => {
      const first = words[0];
      const start = first === undefined ? 0 : first.s;
      const end = words.reduce((latest, word) => Math.max(latest, word.e), start);
      return {
        chunkIdx,
        startMs: byTime ? chunkIdx * CHUNK_MS : start,
        endMs: byTime ? Math.max((chunkIdx + 1) * CHUNK_MS, end) : end,
        words,
      };
    });

  return { ids, chunks };
}

function wordIdAt(ids: readonly WordId[], index: number, label: string): WordId {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const wordId = ids[index];
  if (wordId === undefined) {
    throw new MigrationError(`${label} points at word ${index}, past the end of the transcript`);
  }
  return wordId;
}

/**
 * Rewrites a v1 document as a v2 snapshot. Segment texts and timings survive
 * unchanged: an explicit `startMs`/`endMs` is kept as it was, and one that v1
 * left implicit is read off the words the range covers.
 */
export function migrateV1ToV2(input: unknown): EdgSnapshot {
  const parsed = EdgV1DocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new MigrationError(
      `not a v1 EDG document: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );
  }
  const document = parsed.data;
  const { ids, chunks } = allocateWordIds(document);
  const scripts = document.transcript.scripts ?? ["roman"];
  const primaryScript = scripts[0] ?? "roman";
  const keys = seqSequence(document.segments.length);

  const segments: Segment[] = document.segments.map((legacy, index) => {
    const [from, to] = legacy.wordRange;
    if (to < from) {
      throw new MigrationError(`segment ${legacy.id} has a backwards wordRange [${from}, ${to}]`);
    }
    const startWordId = wordIdAt(ids, from, `segment ${legacy.id}`);
    const endWordId = wordIdAt(ids, to, `segment ${legacy.id}`);
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const firstWord = document.words[from];
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const lastWord = document.words[to];
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const seq = keys[index];
    if (seq === undefined) throw new MigrationError("seqSequence returned too few keys");

    const textOverrides: Record<string, string> = { ...legacy.textOverrides };
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    if (legacy.text !== undefined && textOverrides[primaryScript] === undefined) {
      // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
      textOverrides[primaryScript] = legacy.text;
    }

    const segment: Segment = {
      id: legacy.id,
      seq,
      startWordId,
      endWordId,
      startMs: legacy.startMs ?? firstWord?.s ?? 0,
      endMs: legacy.endMs ?? lastWord?.e ?? 0,
    };
    if (legacy.styleRef !== undefined) segment.styleRef = legacy.styleRef;
    if (Object.keys(textOverrides).length > 0) segment.textOverrides = textOverrides;
    if (legacy.emphasis !== undefined && legacy.emphasis.length > 0) {
      segment.emphasis = legacy.emphasis.map((entry) => ({
        wordId: wordIdAt(ids, entry.wordIndex, `segment ${legacy.id} emphasis`),
        presetId: entry.presetId,
      }));
    }
    if (legacy.position !== undefined) segment.position = legacy.position;
    if (legacy.overrides !== undefined) segment.overrides = legacy.overrides;
    if (legacy.hidden === true) segment.hidden = true;
    return segment;
  });

  return {
    schemaVersion: EDG_SCHEMA_VERSION,
    projection: {
      meta: {
        edgId: document.meta.edgId,
        projectId: document.meta.projectId,
        revision: document.meta.revision,
        schemaVersion: EDG_SCHEMA_VERSION,
        ...(document.meta.engineVersions === undefined
          ? {}
          : { engineVersions: document.meta.engineVersions }),
      },
      media: document.media,
      transcript: {
        transcriptId: document.transcript.transcriptId,
        revision: document.transcript.revision,
        language: document.transcript.language,
        scripts,
        ...(document.transcript.speakers === undefined
          ? {}
          : { speakers: document.transcript.speakers }),
      },
      canvas: document.canvas,
      styles: document.styles,
      ...(document.audio === undefined ? {} : { audio: document.audio }),
      ...(document.render === undefined ? {} : { render: document.render }),
      segments,
      passes: document.passes ?? [],
    },
    chunks,
  };
}
