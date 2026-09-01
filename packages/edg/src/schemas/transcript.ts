import { z } from "zod";

import { isWordId, parseWordId } from "../ids.js";
import { ConfidenceSchema, MsSchema, UlidSchema, WordIdSchema } from "./primitives.js";

/**
 * Per-script text for one word. `roman`/`native` carry the two writing systems of
 * the spoken language (Hinglish is `roman` + `native`), `en` the translation.
 * Frozen in CONTRACTS §2 as `Partial<Record<"roman"|"native"|"en", string>>`.
 */
export const WordScriptsSchema = z
  .object({
    roman: z.string().optional(),
    native: z.string().optional(),
    en: z.string().optional(),
  })
  .meta({ id: "WordScripts", title: "WordScripts" });

/**
 * One transcript word. Times are absolute media milliseconds, the same clock as
 * `Segment.startMs`/`endMs`; `deleted` tombstones a word without reusing its id.
 */
export const WordSchema = z
  .object({
    /** Stable id, `"<chunkIdx>:<n>"`. */
    wid: WordIdSchema,
    /** Start, absolute media ms. */
    s: MsSchema,
    /** End, absolute media ms. */
    e: MsSchema,
    /** Text in the transcript's primary script. */
    t: z.string(),
    /** ASR confidence. */
    c: ConfidenceSchema.optional(),
    /** Speaker id, matching `EdgHot.transcript.speakers[].id`. */
    sp: z.string().min(1).optional(),
    scripts: WordScriptsSchema.optional(),
    /** Filler word ("um", "matlab"), flagged by the cleaner for autocut. */
    filler: z.boolean().optional(),
    /** Tombstone: the id stays addressable, the word is not rendered. */
    deleted: z.boolean().optional(),
  })
  .meta({
    id: "Word",
    title: "Word",
    description: "One transcript word with a stable id (CONTRACTS §2)",
  });

/**
 * One 10-minute transcript chunk (`transcript_chunks`, D28). Every word id in the
 * chunk must carry the chunk's own index — that is what makes `wid` addressable
 * without a lookup table.
 */
export const TranscriptChunkSchema = z
  .object({
    chunkIdx: z.number().int().min(0),
    startMs: MsSchema,
    endMs: MsSchema,
    words: z.array(WordSchema),
  })
  .check((ctx) => {
    const chunk = ctx.value;
    for (const [index, word] of chunk.words.entries()) {
      // A malformed id already failed `WordIdSchema`; do not report it twice.
      if (isWordId(word.wid) && parseWordId(word.wid).chunkIdx !== chunk.chunkIdx) {
        ctx.issues.push({
          code: "custom",
          input: word.wid,
          path: ["words", index, "wid"],
          message: `word id ${word.wid} does not belong to chunk ${chunk.chunkIdx}`,
        });
      }
    }
  })
  .meta({ id: "TranscriptChunk", title: "TranscriptChunk" });

/** One row of the transcript manifest: what a chunk holds, without its words. */
export const TranscriptChunkSummarySchema = z
  .object({
    chunkIdx: z.number().int().min(0),
    startMs: MsSchema,
    endMs: MsSchema,
    /** Words stored in the chunk, tombstones included. */
    wordCount: z.number().int().min(0),
    /** Next `n` to allocate in this chunk; ids are never reused (D28). */
    nextWordSeq: z.number().int().min(0),
  })
  .meta({ id: "TranscriptChunkSummary", title: "TranscriptChunkSummary" });

/**
 * The chunk list for one transcript revision, served by
 * `GET /projects/{id}/transcript/manifest` (07 §Transcripts & EDG).
 */
export const TranscriptManifestSchema = z
  .object({
    transcriptId: UlidSchema,
    revision: z.number().int().min(0),
    /** BCP-47 tag; Hinglish is `hi-Latn`. */
    language: z.string().min(2).max(35),
    chunks: z.array(TranscriptChunkSummarySchema),
  })
  .meta({ id: "TranscriptManifest", title: "TranscriptManifest" });

export type WordScripts = z.infer<typeof WordScriptsSchema>;
export type Word = z.infer<typeof WordSchema>;
export type TranscriptChunk = z.infer<typeof TranscriptChunkSchema>;
export type TranscriptChunkSummary = z.infer<typeof TranscriptChunkSummarySchema>;
export type TranscriptManifest = z.infer<typeof TranscriptManifestSchema>;
