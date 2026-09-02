import { Injectable, Logger } from "@nestjs/common";

import { newId } from "@montaj/edg";
import type { ScriptId, TranscriptChunk } from "@montaj/edg/schemas";

import { PrismaService } from "../common/prisma/prisma.service.js";
import { newestChunkRows } from "../edg/chunk-rows.js";

import type { ChunkRow } from "../edg/edg.rows.js";
import type { DetectedLanguage } from "./postprocess/index.js";
import type { Prisma, RetentionClass, Transcript } from "@prisma/client";

/**
 * A chunk on its way into the database.
 *
 * `nextWordSeq` is the column the worker already fills (A09's `_result`) and the
 * one A12 allocates new word ids from. It is carried alongside the frozen
 * `TranscriptChunk` shape rather than added to it, because CONTRACTS §2 does not
 * put it on the document type — it is a property of the row, not of the chunk.
 */
export interface IngestChunk extends TranscriptChunk {
  readonly nextWordSeq?: number;
}

/**
 * The write side of `transcripts`, `transcript_chunks` and `provider_submissions`.
 *
 * ### One transaction, and what is deliberately outside it
 *
 * {@link persist} writes all three tables in a single transaction, so a reader
 * never sees a transcript whose chunks are half there or a provider submission
 * with no transcript behind it. The **EDG document is not in it**: A12's
 * `EdgService.initialise` opens its own transaction (`EdgRepository.createDocument`),
 * and Prisma has no way to hand an interactive transaction to a second service —
 * nesting one would silently run on a different connection and deadlock against
 * the first.
 *
 * That is safe rather than a compromise, because both halves are idempotent and
 * the order is the safe one: the transcript exists before anything points at it,
 * and `initialise` is idempotent by project (A12's README), so a handler that
 * crashes between the two and is retried by the worker converges on the same
 * rows. The reverse order — document first — would be the unsafe one.
 *
 * ### Idempotency
 *
 * The transcript id is minted by the **producer** and travels in the job payload,
 * so a retried completion writes to the same row rather than making a second
 * transcript. Within it, the chunk set for a revision is replaced wholesale
 * (`deleteMany` then `createMany`, keyed by the `(transcript_id, revision,
 * chunk_idx)` unique index) and the job's provider submissions likewise, which
 * makes re-running the handler an overwrite rather than a duplication.
 */

export interface PersistTranscriptInput {
  readonly transcriptId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly mediaId: string | null;
  readonly revision: number;
  readonly language: string;
  readonly detectedLanguages: readonly DetectedLanguage[];
  readonly provider: string | null;
  readonly model: string | null;
  readonly alignerModel: string | null;
  readonly diariser: string | null;
  readonly chunks: readonly IngestChunk[];
  /** Script slots the transcript carries; mirrored onto `projects.scripts`. */
  readonly scripts: readonly ScriptId[];
  readonly submissions: readonly ProviderSubmissionInput[];
}

/** One external call the worker made, as `provider_submissions` records it. */
export interface ProviderSubmissionInput {
  readonly provider: string;
  readonly endpoint: string | null;
  readonly region: string | null;
  readonly externalRef: string | null;
  readonly artefactKind: string;
  readonly retentionClass: RetentionClass;
}

export interface PersistedTranscript {
  readonly transcript: Transcript;
  readonly chunks: number;
  readonly words: number;
  readonly submissions: number;
}

@Injectable()
export class TranscriptsRepository {
  private readonly logger = new Logger(TranscriptsRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Write the transcript, its chunks and the provider submissions, atomically. */
  async persist(input: PersistTranscriptInput): Promise<PersistedTranscript> {
    const detected = input.detectedLanguages as unknown as Prisma.InputJsonValue;

    return this.prisma.withTransaction(
      async (tx) => {
        const transcript = await tx.transcript.upsert({
          where: { id: input.transcriptId },
          create: {
            id: input.transcriptId,
            projectId: input.projectId,
            language: input.language,
            detectedLanguages: detected,
            provider: input.provider,
            model: input.model,
            alignerModel: input.alignerModel,
            diariser: input.diariser,
            currentRevision: input.revision,
          },
          update: {
            language: input.language,
            detectedLanguages: detected,
            provider: input.provider,
            model: input.model,
            alignerModel: input.alignerModel,
            diariser: input.diariser,
            currentRevision: input.revision,
          },
        });

        // Replace the revision's chunks rather than adding to them: a retried
        // completion must produce the same rows, not twice as many.
        await tx.transcriptChunk.deleteMany({
          where: { transcriptId: input.transcriptId, revision: input.revision },
        });
        await tx.transcriptChunk.createMany({
          data: input.chunks.map((chunk) => ({
            id: newId(),
            transcriptId: input.transcriptId,
            revision: input.revision,
            chunkIdx: chunk.chunkIdx,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
            words: chunk.words as unknown as Prisma.InputJsonValue,
            // Ids are allocated from here and never reused (06 invariant 4), so it
            // is the count of ids *issued*, tombstones included — not of live words.
            nextWordSeq: nextWordSeqOf(chunk),
          })),
        });

        await tx.providerSubmission.deleteMany({ where: { jobId: input.jobId } });
        if (input.submissions.length > 0) {
          await tx.providerSubmission.createMany({
            data: input.submissions.map((submission) => ({
              id: newId(),
              jobId: input.jobId,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              mediaId: input.mediaId,
              provider: submission.provider,
              endpoint: submission.endpoint,
              region: submission.region,
              externalRef: submission.externalRef,
              artefactKind: submission.artefactKind,
              retentionClass: submission.retentionClass,
            })),
          });
        }

        // The project's own language and scripts follow the transcript: A06's
        // project list shows them and B12's search filters on them.
        await tx.project.updateMany({
          where: { id: input.projectId },
          data: { sourceLanguage: input.language, scripts: [...input.scripts] },
        });

        const words = input.chunks.reduce((total, chunk) => total + chunk.words.length, 0);
        return {
          transcript,
          chunks: input.chunks.length,
          words,
          submissions: input.submissions.length,
        };
      },
      // A 60-minute transcript is six chunks of ~1 500 words; the default 10 s is
      // enough for that, and a three-hour recording needs the headroom.
      { timeoutMs: 30_000, maxWaitMs: 10_000 },
    );
  }

  /** The newest transcript of a project, or `null`. */
  async latest(projectId: string): Promise<Transcript | null> {
    return this.prisma.transcript.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }
  /**
   * One page of chunks, by `chunk_idx`, as of `revision`.
   *
   * "As of `revision`" is never a plain `WHERE revision = $1` (A11d): a word
   * edit patches a chunk's row in place and advances `transcripts.currentRevision`
   * without touching that row's own `revision` column, so the chunk as of any
   * revision at or after the one it was written at is that same row. Resolved by
   * `newestChunkRows`, the same helper `EdgRepository` reads the live document
   * through, bounded here so a page never mixes past and future generations —
   * only a re-transcription (`persist`, a new `chunkIdx=0..N` generation) can
   * make that bound matter.
   */
  async chunkPage(
    transcriptId: string,
    revision: number,
    after: number | undefined,
    limit: number,
  ): Promise<ChunkRow[]> {
    const rows = await newestChunkRows(this.prisma, transcriptId, { maxRevision: revision });
    const page = after === undefined ? rows : rows.filter((row) => row.chunkIdx > after);
    return page.slice(0, limit);
  }

  /** Every chunk as of `revision`, in order. Used by the exporters. */
  async allChunks(transcriptId: string, revision: number): Promise<ChunkRow[]> {
    return newestChunkRows(this.prisma, transcriptId, { maxRevision: revision });
  }

  /** Chunk count and word total as of `revision`, for the manifest. */
  async summarise(
    transcriptId: string,
    revision: number,
  ): Promise<{ chunks: number; durationMs: number }> {
    const rows = await newestChunkRows(this.prisma, transcriptId, { maxRevision: revision });
    const durationMs = rows.reduce((latest, row) => Math.max(latest, row.endMs), 0);
    return { chunks: rows.length, durationMs };
  }
}

/**
 * The next free `n` in a chunk.
 *
 * Not `words.length`: post-processing tombstones the words a number run consumed,
 * and those ids are spent for ever (06 invariant 4). It is one past the highest
 * `n` the chunk has ever issued — which the ids themselves record — and never
 * below what the worker already claimed to have allocated.
 */
export function nextWordSeqOf(chunk: IngestChunk): number {
  let highest = -1;
  for (const word of chunk.words) {
    const n = Number(word.wid.split(":")[1] ?? "-1");
    if (Number.isFinite(n) && n > highest) highest = n;
  }
  return Math.max(chunk.nextWordSeq ?? 0, chunk.words.length, highest + 1);
}
