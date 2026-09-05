import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { newId } from "@montaj/edg";
import type { Segment, TranscriptChunk } from "@montaj/edg/schemas";

import { renderExport } from "./transcript-export.js";
import {
  MAX_TRANSCRIPT_CHUNK_PAGE_SIZE,
  TRANSCRIPT_CHUNK_PAGE_SIZE,
  TRANSCRIPT_ERROR_CODES,
} from "./transcripts.errors.js";
import { quoteTranscription } from "./transcripts.quote.js";
import { TranscriptsRepository } from "./transcripts.repository.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgService } from "../edg/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { MemoryService } from "../memory/memory.service.js";

import type { Correction, DetectedLanguage } from "./postprocess/index.js";
import type { TranscriptExportFormat } from "./transcript-export.js";
import type { TranscriptionState } from "./transcripts.dto.js";
import type { CaptionPreferences } from "../edg/init/index.js";
import type { MediaAsset, Project, Transcript } from "@prisma/client";

/**
 * The transcripts feature: the producer that starts a transcription, and the
 * reads that make one useful.
 *
 * ### Tenancy
 *
 * Every entry point starts from `(projectId, workspaceId)` and a project in
 * another workspace is a **404, never a 403** — an id must not be testable for
 * existence (THREAT-MODEL T4, T5). That is the same rule `EdgService` follows and
 * for the same reason; it is repeated rather than shared because a helper that
 * both call would make the rule easy to forget in the third module.
 *
 * ### Producing (CONTRACTS §4)
 *
 * ```
 * project + primary media, probed?      → transcript/media_not_ready otherwise
 * quote from packages/config             (1 credit per media minute, rounded up)
 * mint transcriptId                      (the completion writes to THIS row)
 * JobsService.enqueue                    (admission → row → reserve → BullMQ)
 * ```
 *
 * The `transcripts` row is **not** created here. A transcription that fails, is
 * cancelled or times out would otherwise leave a permanent empty transcript
 * attached to the project, and every reader would have to learn to ignore it. The
 * id is minted here and travels in the job payload instead, which gives the
 * completion handler a stable identity to write to — the same idempotency the row
 * would have provided, without the debris.
 */

/** Cap on merged transcribe hints (request-time + memory glossary), brief §2. */
export const MAX_TRANSCRIBE_HINTS = 200;

export interface TranscribeRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly userId: string;
  /** Language hints, best first. The first is passed to the provider. */
  readonly languages?: readonly string[];
  /** Glossary terms for hotword boosting and post-correction. */
  readonly hints?: readonly string[];
  /** Ask the provider for speaker labels. Free — the burn rate includes it. */
  readonly diarise?: boolean;
  readonly captions?: CaptionPreferences;
  /** Re-transcribe over a project whose captions have already been edited. */
  readonly force?: boolean;
}

export interface TranscribeAccepted {
  readonly jobId: string;
  readonly transcriptId: string;
  readonly status: string;
  /** True when a live transcription already existed and this call enqueued nothing. */
  readonly deduplicated: boolean;
  readonly quote: {
    readonly tenths: number;
    readonly credits: string;
    readonly durationMs: number;
  };
}

export interface TranscriptChunkPage {
  readonly transcript: TranscriptView;
  readonly chunks: readonly TranscriptChunk[];
  /** The last `chunkIdx` returned; pass it back as `cursor`. `null` at the end. */
  readonly nextCursor: number | null;
}

export interface TranscriptView {
  readonly id: string;
  readonly projectId: string;
  readonly revision: number;
  readonly language: string;
  readonly detectedLanguages: readonly DetectedLanguage[];
  readonly provider: string | null;
  readonly model: string | null;
  readonly alignerModel: string | null;
  readonly diariser: string | null;
  readonly chunkCount: number;
  readonly durationMs: number;
  readonly createdAt: string;
  /** What post-processing changed, from the job event the handler wrote. */
  readonly postProcessing?: {
    readonly steps: readonly string[];
    readonly correctionCount: number;
    readonly corrections: readonly Correction[];
    readonly truncated: boolean;
    readonly languageDisagreement: boolean;
  };
}

@Injectable()
export class TranscriptsService {
  private readonly logger = new Logger(TranscriptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: TranscriptsRepository,
    private readonly jobs: JobsService,
    private readonly edg: EdgService,
    private readonly memory: MemoryService,
  ) {}

  // -------------------------------------------------------------------------
  // Producing
  // -------------------------------------------------------------------------

  /** `POST /projects/{id}/transcribe` — the first transcription of a project. */
  async transcribe(request: TranscribeRequest): Promise<TranscribeAccepted> {
    return this.enqueueTranscription(request, { retranscribe: false });
  }

  /**
   * FIX-03's read model: the single truth the upload tray, the editor's waiting
   * screen and the shell all render. Derived on demand from rows that already
   * exist — deliberately no stored status column, so there is nothing to drift.
   */
  async transcriptionState(
    projectId: string,
    workspaceId: string,
  ): Promise<{ status: TranscriptionState; jobId?: string; error?: string }> {
    const project = await this.project(projectId, workspaceId); // 404s across tenants
    const transcript = await this.repository.latest(project.id);
    if (transcript !== null) return { status: "ready" };

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: project.id, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { status: true, durationMs: true },
    });
    if (media === null) return { status: "no_media" };
    if (media.status !== "ready" || media.durationMs === null || media.durationMs <= 0) {
      return { status: "processing_media" };
    }

    const job = await this.prisma.job.findFirst({
      where: { projectId: project.id, type: "ai.transcribe" },
      orderBy: { queuedAt: "desc" },
      select: { id: true, status: true, error: true },
    });
    if (job !== null) {
      if (job.status === "queued") return { status: "queued", jobId: job.id };
      if (job.status === "running") return { status: "running", jobId: job.id };
      if (job.status === "failed" || job.status === "cancelled") {
        return { status: "failed", jobId: job.id, error: jobErrorMessage(job.error) };
      }
      // succeeded but no transcript row yet: the completion handler is mid-write —
      // report running so the caller keeps waiting instead of flashing an error.
      return { status: "running", jobId: job.id };
    }

    if (project.sourceLanguage === null || project.sourceLanguage.trim() === "") {
      return { status: "awaiting_language" };
    }
    // Media ready, language chosen, no job: the auto-start never ran or was
    // refused (a zero-credit workspace lands here). The waiting screen offers the
    // explicit start, whose 402 carries the credit story.
    return { status: "not_started" };
  }

  /**
   * `POST /projects/{id}/transcript/retranscribe`.
   *
   * Refused with `transcript/has_edits` when the editing document has moved past
   * the revision the first transcription created, unless the caller passes
   * `force`. The refusal is the point: a re-transcription replaces every word id,
   * and captions the user has retimed, split or retyped are addressed **by** those
   * ids. Answering 409 with a named flag is how the user says "yes, I know" rather
   * than discovering it afterwards.
   */
  async retranscribe(request: TranscribeRequest): Promise<TranscribeAccepted> {
    return this.enqueueTranscription(request, { retranscribe: true });
  }

  /**
   * Request-time hints (caller-supplied) plus the workspace's consented
   * glossary/spelling memory terms (`MemoryService.glossaryTermsFor()`),
   * request-time first, deduplicated, capped at {@link MAX_TRANSCRIBE_HINTS}
   * (brief §2). Consent-gated inside `MemoryService` — no consent means no
   * memory terms are appended, never a thrown error.
   */
  private async buildHints(request: TranscribeRequest): Promise<readonly string[]> {
    const requested = (request.hints ?? [])
      .map((hint) => hint.trim())
      .filter((hint) => hint !== "");
    const memoryTerms = await this.memory.glossaryTermsFor(request.workspaceId, request.userId);

    const seen = new Set<string>();
    const merged: string[] = [];
    for (const hint of [...requested, ...memoryTerms]) {
      const key = hint.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(hint);
      if (merged.length >= MAX_TRANSCRIBE_HINTS) break;
    }
    return merged;
  }

  private async enqueueTranscription(
    request: TranscribeRequest,
    options: { retranscribe: boolean },
  ): Promise<TranscribeAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);

    if (options.retranscribe) await this.assertNoEdits(project.id, request.force === true);

    const quote = quoteTranscription(media.durationMs ?? 0);
    const transcriptId = newId();
    const languages = (request.languages ?? []).filter((tag) => tag.trim() !== "");
    const hints = await this.buildHints(request);

    // A distinct job key per transcript id: dedupe must stop a double-click on the
    // same request, and must not stop a deliberate re-transcription.
    const jobKey = options.retranscribe
      ? `transcribe:${project.id}:${transcriptId}`
      : `transcribe:${project.id}:${media.id}`;

    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.transcribe",
      workspaceId: request.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        transcriptId,
        mediaId: media.id,
        // `audio16k.wav` is the worker's input (`06 §storage keys`); a project that
        // has been probed always has it.
        audioKey: media.audio16kKey,
        durationMs: media.durationMs,
        ...(languages[0] === undefined ? {} : { language: languages[0] }),
        ...(languages.length > 1 ? { languages } : {}),
        ...(hints.length === 0 ? {} : { hints }),
        // Hinglish is the default assumption for this market, and the routing
        // table (`worker_ai/routing.yaml`) reads it to pick a code-mix lane.
        codeMix: languages.length > 1 || languages.some((tag) => /-latn$/i.test(tag)),
        diarise: request.diarise === true,
        revision: 1,
        ...(request.captions === undefined ? {} : { captions: request.captions }),
      },
    });

    this.logger.log(
      {
        projectId: project.id,
        jobId: job.id,
        transcriptId,
        tenths: quote.tenths,
        deduplicated,
        retranscribe: options.retranscribe,
      },
      "transcription enqueued",
    );

    return {
      jobId: job.id,
      // A deduplicated call returns the live job's transcript id, not the one this
      // call minted — the caller must poll the job that is actually running.
      transcriptId: deduplicated ? (transcriptIdOf(job.params) ?? transcriptId) : transcriptId,
      status: job.status,
      deduplicated,
      quote: { tenths: quote.tenths, credits: quote.credits, durationMs: quote.durationMs },
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * `GET /projects/{id}/transcript` — the manifest and one page of chunks.
   *
   * `script` (A22) projects each word's `t` onto that script's variant
   * (`scripts[script]`, falling back to the word's own primary text for a word
   * that carries none — an English token inside a transliterated Hinglish
   * segment, say). `translated` is a segment-level override, not a per-word
   * field, so it leaves `t` alone; the editor reads a translation from the EDG
   * segments, not from here. Omitted keeps every word's own primary text, byte
   * for byte, as A11 shipped it.
   */
  async chunks(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly cursor?: number;
    readonly limit?: number;
    readonly revision?: number;
    readonly script?: string;
  }): Promise<TranscriptChunkPage> {
    const transcript = await this.transcriptOf(input.projectId, input.workspaceId);
    const revision = input.revision ?? transcript.currentRevision;
    const take = clampPage(input.limit);

    const rows = await this.repository.chunkPage(transcript.id, revision, input.cursor, take + 1);
    const page = rows.slice(0, take);
    const last = page[page.length - 1];

    return {
      transcript: await this.view(transcript, revision),
      chunks: page.map((row) => toChunk(row, input.script)),
      nextCursor: rows.length > take && last !== undefined ? last.chunkIdx : null,
    };
  }

  /**
   * `GET /projects/{id}/transcript/export` — the whole transcript in one file.
   *
   * Source time only. The captions come from the editing document when there is
   * one, so an export reflects what the user edited rather than what the ASR first
   * produced.
   */
  async export(input: {
    readonly projectId: string;
    readonly workspaceId: string;
    readonly format: TranscriptExportFormat;
    readonly revision?: number;
    readonly dropFillers?: boolean;
    /** A22: `roman` | `native` | `en` | `translated`. Omitted keeps the primary script. */
    readonly script?: string;
  }): Promise<{ body: string; filename: string }> {
    const transcript = await this.transcriptOf(input.projectId, input.workspaceId);
    const revision = input.revision ?? transcript.currentRevision;
    const rows = await this.repository.allChunks(transcript.id, revision);

    const body = renderExport(input.format, {
      transcriptId: transcript.id,
      revision,
      language: transcript.language,
      chunks: rows.map((row) => toChunk(row)),
      segments: await this.segmentsOf(input.projectId, input.workspaceId),
      dropFillers: input.dropFillers ?? false,
      ...(input.script === undefined ? {} : { script: input.script }),
    });

    return { body, filename: `transcript-${transcript.id}.${input.format}` };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The project, or a 404 — including when it belongs to somebody else (T5). */
  private async project(projectId: string, workspaceId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    return project;
  }

  /**
   * The project's primary media, which must be **probed**: a transcription is
   * quoted on its duration and there is no honest quote without one.
   */
  private async primaryMedia(projectId: string): Promise<MediaAsset> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });
    if (media === null) {
      throw new AppException(
        TRANSCRIPT_ERROR_CODES.mediaNotReady,
        "This project has no media to transcribe.",
        HttpStatus.CONFLICT,
        { projectId },
      );
    }
    if (media.status !== "ready" || media.durationMs === null || media.durationMs <= 0) {
      throw new AppException(
        TRANSCRIPT_ERROR_CODES.mediaNotReady,
        "The media has not finished processing yet.",
        HttpStatus.CONFLICT,
        { mediaId: media.id, status: media.status },
      );
    }
    return media;
  }

  private async transcriptOf(projectId: string, workspaceId: string): Promise<Transcript> {
    await this.project(projectId, workspaceId);
    const transcript = await this.repository.latest(projectId);
    if (transcript === null) {
      throw new AppException(
        TRANSCRIPT_ERROR_CODES.notFound,
        "This project has no transcript yet.",
        HttpStatus.NOT_FOUND,
        { projectId },
      );
    }
    return transcript;
  }

  /**
   * Refuse a re-transcription that would discard edits, unless forced.
   *
   * "Edited" is `edg_documents.revision > 1`: A11 writes revision 1 and every
   * later revision is an op batch somebody submitted.
   */
  private async assertNoEdits(projectId: string, force: boolean): Promise<void> {
    if (force) return;
    const document = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { revision: true },
    });
    if (document === null || document.revision <= 1) return;
    throw new AppException(
      TRANSCRIPT_ERROR_CODES.hasEdits,
      "This project's captions have been edited; re-transcribing would replace them.",
      HttpStatus.CONFLICT,
      { revision: document.revision, retryWith: { force: true } },
    );
  }

  /** The document's captions, or none when it has not been initialised. */
  private async segmentsOf(projectId: string, workspaceId: string): Promise<Segment[]> {
    const segments: Segment[] = [];
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await this.edg.segments(projectId, workspaceId, cursor, 1_000);
      } catch {
        // `edg/not_initialised`: transcribed but never opened. The exporter groups
        // the words itself rather than returning an empty file.
        return [];
      }
      segments.push(...page.segments);
      if (page.nextCursor === null) return segments;
      cursor = page.nextCursor;
    }
  }

  /** The manifest, with the post-processing log the completion handler wrote. */
  private async view(transcript: Transcript, revision: number): Promise<TranscriptView> {
    const summary = await this.repository.summarise(transcript.id, revision);
    // `job_events` has no `name` column: the event name lives in `data.event`
    // (A08's `JobEventsService.row`), so this is a JSONB path filter rather than a
    // column comparison. Newest first by id, which is a ULID and therefore time-ordered.
    const event = await this.prisma.jobEvent.findFirst({
      where: {
        data: { path: ["event"], equals: "transcript.postprocessed" },
        job: { projectId: transcript.projectId },
      },
      orderBy: { id: "desc" },
      select: { data: true },
    });

    return {
      id: transcript.id,
      projectId: transcript.projectId,
      revision,
      language: transcript.language,
      detectedLanguages: (transcript.detectedLanguages ?? []) as unknown as DetectedLanguage[],
      provider: transcript.provider,
      model: transcript.model,
      alignerModel: transcript.alignerModel,
      diariser: transcript.diariser,
      chunkCount: summary.chunks,
      durationMs: summary.durationMs,
      createdAt: transcript.createdAt.toISOString(),
      ...postProcessingOf(event?.data, transcript.id),
    };
  }
}

/** `transcript_chunks` row → the frozen `TranscriptChunk` shape. */
/**
 * `transcript_chunks` row -> the frozen `TranscriptChunk` shape.
 *
 * `script` (A22, `GET /projects/{id}/transcript` only — never for export, which
 * reads `scripts` itself through `transcript-export.ts`) projects every word's
 * `t` onto that script's variant, falling back to the word's own primary text.
 * `translated` is segment-level, so it is not a projection this function makes;
 * `t` is left as the transcript's primary text and a caller wanting the
 * translation reads the EDG segment's `textOverrides.translated` instead.
 */
function toChunk(
  row: { chunkIdx: number; startMs: number; endMs: number; words: unknown },
  script?: string,
): TranscriptChunk {
  const words = (row.words ?? []) as TranscriptChunk["words"];
  const projected =
    script === undefined || script === "translated"
      ? words
      : words.map((word) => projectWord(word, script));
  return {
    chunkIdx: row.chunkIdx,
    startMs: row.startMs,
    endMs: row.endMs,
    words: projected,
  };
}

/** One word with `t` replaced by its `script` variant, when it carries one. */
function projectWord(
  word: TranscriptChunk["words"][number],
  script: string,
): TranscriptChunk["words"][number] {
  const variant = word.scripts?.[script as "roman" | "native" | "en"];
  return variant === undefined ? word : { ...word, t: variant };
}

/** Pull the corrections log out of the job event, when it is this transcript's. */
function postProcessingOf(
  data: unknown,
  transcriptId: string,
): Pick<TranscriptView, "postProcessing"> {
  if (typeof data !== "object" || data === null) return {};
  const record = data as Record<string, unknown>;
  if (record["transcriptId"] !== transcriptId) return {};

  return {
    postProcessing: {
      steps: Array.isArray(record["steps"]) ? (record["steps"] as string[]) : [],
      correctionCount:
        typeof record["correctionCount"] === "number" ? record["correctionCount"] : 0,
      corrections: Array.isArray(record["corrections"])
        ? (record["corrections"] as Correction[])
        : [],
      truncated: record["truncated"] === true,
      languageDisagreement: record["languageDisagreement"] === true,
    },
  };
}

function clampPage(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TRANSCRIPT_CHUNK_PAGE_SIZE;
  return Math.min(MAX_TRANSCRIPT_CHUNK_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/** The transcript id a live job is already writing to. */
function transcriptIdOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)["transcriptId"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The reason a failed transcription can show a user.
 *
 * `jobs.error` is JSONB shaped `{code, message, retryable}` (`JobErrorSchema` in
 * `jobs/contracts/completion.ts`), not a string — so the sentence the waiting
 * screen renders comes out of `message`. A row that ever stored a bare string
 * still reads correctly, and an unusable value falls back to a plain sentence
 * rather than leaking a code at the user.
 */
function jobErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim() !== "") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.trim() !== "") return message;
  }
  return "The transcription failed.";
}
