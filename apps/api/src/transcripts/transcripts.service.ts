import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { newId, type EdgOp } from "@montaj/edg";
import type { Segment, TranscriptChunk } from "@montaj/edg/schemas";

import {
  firstTranscriptionCanStart,
  firstTranscriptionJobKey,
  languageHints,
} from "./first-transcription.js";
import { TranscriptDocumentService } from "./transcript-document.service.js";
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
import type { ChunkRow } from "../edg/edg.rows.js";
import { JobsService } from "../jobs/jobs.service.js";
import { MediaProbeRestart, neverProbed } from "../media/probe-restart.js";
import { MemoryService } from "../memory/memory.service.js";

import type { Correction, DetectedLanguage } from "./postprocess/index.js";
import type { TranscriptExportFormat } from "./transcript-export.js";
import type { TranscriptionState } from "./transcripts.dto.js";
import type { CaptionPreferences } from "../edg/init/index.js";
import type { MediaAsset, Prisma, Project, Transcript } from "@prisma/client";

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
    private readonly documents: TranscriptDocumentService,
    private readonly probes: MediaProbeRestart,
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
    if (transcript !== null) return this.stateWithTranscript(project.id);

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: project.id, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { status: true, durationMs: true, failureReason: true, createdAt: true },
    });
    if (media === null) return { status: "no_media" };

    if (media.status === "failed") {
      return {
        status: "failed",
        error: media.failureReason ?? "Media processing failed. Please try re-uploading the file.",
      };
    }

    // A first transcription can run while the video is still being prepared
    // (clips pipeline W5: it starts on the audio `media.proxy` writes back ahead
    // of its encode). Report it as it is — not "processing media", and never as
    // the timeout below, which a long source's encode outlasts while its
    // transcription is well under way.
    if (media.status !== "ready") {
      const open = await this.prisma.job.findFirst({
        where: {
          projectId: project.id,
          type: { in: ["ai.transcribe", "ai.align"] },
          status: { in: ["queued", "running"] },
        },
        orderBy: { queuedAt: "desc" },
        select: { id: true, status: true },
      });
      if (open?.status === "queued") return { status: "queued", jobId: open.id };
      if (open?.status === "running") return { status: "running", jobId: open.id };
    }

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    if (
      (media.status === "pending" || media.status === "uploading" || media.status === "probing") &&
      media.createdAt &&
      media.createdAt < fiveMinutesAgo
    ) {
      return {
        status: "failed",
        error: "Media upload or processing timed out. Please try re-uploading the file.",
      };
    }

    if (media.status !== "ready" || media.durationMs === null || media.durationMs <= 0) {
      return { status: "processing_media" };
    }

    const job = await this.prisma.job.findFirst({
      // S-06: an imported-subtitles project waits on `ai.align`, not
      // `ai.transcribe`; the newest of either is the one the screen is waiting on.
      where: { projectId: project.id, type: { in: ["ai.transcribe", "ai.align"] } },
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
   * `ready` means *the editor can open*, which takes an editing document — not
   * merely a transcript. Answering `ready` on the transcript alone is what
   * trapped every repurposed clip: the editor's waiting screen heard `ready`,
   * asked the editor to load, got `edg/not_initialised` back, and remounted into
   * the same question several times a second (`TranscriptDocumentService`).
   *
   * A transcript without a document is one of three things, in this order:
   *
   * 1. **A producer mid-write.** A completion handler persists the transcript and
   *    then initialises the document, and runs before its job's status flips —
   *    so while that job is still open, report it rather than race it.
   * 2. **Media still being prepared.** A clip's transcript is cloned before its
   *    video is probed; `AutoTranscribeTrigger` builds the document on
   *    `media.proxy` success, against the probed dimensions. Media that claims
   *    `ready` but was **never probed** (every clip cut before 2026-09-25) is
   *    sent back through that pipeline here rather than opened with no preview.
   * 3. **A document that was never built.** Build it now, from the stored words
   *    (no credits). If even that fails, say so — never a spinner.
   */
  private async stateWithTranscript(
    projectId: string,
  ): Promise<{ status: TranscriptionState; jobId?: string; error?: string }> {
    const document = await this.prisma.edgDocument.findUnique({
      where: { projectId },
      select: { id: true },
    });
    if (document !== null) return { status: "ready" };

    const job = await this.prisma.job.findFirst({
      where: { projectId, type: { in: ["ai.transcribe", "ai.align"] } },
      orderBy: { queuedAt: "desc" },
      select: { id: true, status: true },
    });
    if (job?.status === "queued") return { status: "queued", jobId: job.id };
    if (job?.status === "running") return { status: "running", jobId: job.id };

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        projectId: true,
        status: true,
        storageKey: true,
        mime: true,
        sizeBytes: true,
        hasAudio: true,
        width: true,
        proxyKey: true,
        project: { select: { workspaceId: true } },
      },
    });
    if (media !== null && media.status !== "ready" && media.status !== "failed") {
      return { status: "processing_media" };
    }
    if (media !== null && neverProbed(media)) {
      // `busy` (the plan's lane is full) is waited out — the screen polls again
      // — rather than opened with no preview; only a video that cannot be
      // probed at all falls through to building the document without one.
      const restarted = await this.probes.restart(media, media.project.workspaceId);
      if (restarted !== "failed") return { status: "processing_media" };
    }

    try {
      const outcome = await this.documents.ensure(projectId);
      if (outcome.status !== "no_transcript") return { status: "ready" };
    } catch (error) {
      // Two tabs polling at once both try to build it; the loser trips the
      // unique `edg_documents.project_id` — which means it now exists.
      const built = await this.prisma.edgDocument.findUnique({
        where: { projectId },
        select: { id: true },
      });
      if (built !== null) return { status: "ready" };
      this.logger.error(
        { projectId, err: error instanceof Error ? error.message : String(error) },
        "a transcript exists but its editing document could not be built",
      );
    }
    return {
      status: "failed",
      error: "This project's transcript is saved, but the editor could not be prepared from it.",
    };
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
  private async buildHints(
    request: TranscribeRequest,
    _sourceLanguage?: string | null,
  ): Promise<readonly string[]> {
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
    // A first transcription may start on audio the proxy wrote back ahead of
    // its video encode (`first-transcription.ts`). A re-transcription waits for
    // `ready`: it has a transcript to fall back on, and no head start to win.
    const media = await this.primaryMedia(project.id, { audioFirst: !options.retranscribe });

    if (options.retranscribe) await this.assertNoEdits(project.id, request.force === true);

    const quote = quoteTranscription(media.durationMs ?? 0);
    const transcriptId = newId();
    // "auto" (detect it) is sent as no hint at all; see `languageHints`.
    const languages = languageHints(request.languages);
    const hints = await this.buildHints(request, project.sourceLanguage);

    const audioTracks = await this.prisma.mediaAudioTrack.findMany({
      where: { mediaAssetId: media.id },
      orderBy: [{ streamIndex: "asc" }, { channelIndex: "asc" }],
    });

    // A distinct job key per transcript id: dedupe must stop a double-click on the
    // same request, and must not stop a deliberate re-transcription.
    const jobKey = options.retranscribe
      ? `transcribe:${project.id}:${transcriptId}`
      : firstTranscriptionJobKey(project.id, media.id);

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
        ...(audioTracks.length > 0
          ? {
              audioTracks: audioTracks.map((t) => ({
                id: t.id,
                streamIndex: t.streamIndex,
                channelIndex: t.channelIndex,
                label: t.label,
                audioWavUri: t.audioWavUri,
                durationMs: t.durationMs,
                isDialogue: t.isDialogue,
                speakerName: t.speakerName,
              })),
            }
          : {}),
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
  // Mutations (08-inline-subtitle-editor)
  // -------------------------------------------------------------------------

  /** Resolves transcript by either transcript ID or project ID, enforcing workspace tenancy. */
  async resolveTranscript(
    idOrProjectId: string,
    workspaceId: string,
  ): Promise<{ transcript: Transcript; project: Project }> {
    const byId = await this.prisma.transcript.findUnique({
      where: { id: idOrProjectId },
      include: { project: true },
    });
    if (byId !== null && byId.project.workspaceId === workspaceId && byId.project.deletedAt === null) {
      return { transcript: byId, project: byId.project };
    }

    const project = await this.prisma.project.findFirst({
      where: { id: idOrProjectId, workspaceId, deletedAt: null },
    });
    if (project !== null) {
      const transcript = await this.repository.latest(project.id);
      if (transcript !== null) {
        return { transcript, project };
      }
    }

    throw new AppException(
      TRANSCRIPT_ERROR_CODES.notFound,
      "No such transcript found for this workspace.",
      HttpStatus.NOT_FOUND,
      { id: idOrProjectId },
    );
  }

  /**
   * Updates a single word in the transcript (text, emphasis, emoji, color).
   * Preserves exact millisecond acoustic timing anchors during text modifications.
   */
  async updateWord(input: {
    readonly idOrProjectId: string;
    readonly wordId: string;
    readonly workspaceId: string;
    readonly data: {
      readonly text?: string;
      readonly isEmphasized?: boolean;
      readonly emphasis?: boolean;
      readonly emoji?: string | null;
      readonly color?: string | null;
      readonly script?: string;
    };
  }): Promise<{
    readonly success: boolean;
    readonly wordId: string;
    readonly text?: string;
    readonly isEmphasized?: boolean;
    readonly emoji?: string | null;
    readonly color?: string | null;
    readonly revision: number;
  }> {
    const { transcript, project } = await this.resolveTranscript(input.idOrProjectId, input.workspaceId);
    const rows = await this.repository.allChunks(transcript.id, transcript.currentRevision);

    let targetRow: ChunkRow | undefined;
    let targetWordIndex = -1;
    let targetWord: Record<string, unknown> | null = null;

    for (const row of rows) {
      const words = (row.words ?? []) as Array<Record<string, unknown>>;
      const idx = words.findIndex((w) => w["wid"] === input.wordId || w["id"] === input.wordId);
      if (idx !== -1) {
        targetRow = row;
        targetWordIndex = idx;
        targetWord = words[idx] ?? null;
        break;
      }
    }

    if (targetRow === undefined || targetWord === null) {
      throw new AppException(
        TRANSCRIPT_ERROR_CODES.notFound,
        `Word with id ${input.wordId} not found in transcript.`,
        HttpStatus.NOT_FOUND,
      );
    }

    const updatedWords = [...((targetRow.words as Array<Record<string, unknown>>) ?? [])];
    const wordClone = { ...targetWord };

    if (input.data.text !== undefined) {
      wordClone["t"] = input.data.text;
      wordClone["text"] = input.data.text;
      const scriptKey = input.data.script ?? "roman";
      const existingScripts = (wordClone["scripts"] as Record<string, string> | undefined) ?? {};
      wordClone["scripts"] = { ...existingScripts, [scriptKey]: input.data.text };
    }

    if (input.data.isEmphasized !== undefined || input.data.emphasis !== undefined) {
      const emph = input.data.isEmphasized ?? input.data.emphasis;
      wordClone["isEmphasized"] = emph;
    }

    if (input.data.emoji !== undefined) {
      wordClone["emoji"] = input.data.emoji;
    }

    if (input.data.color !== undefined) {
      wordClone["color"] = input.data.color ?? undefined;
      wordClone["accentColor"] = input.data.color ?? undefined;
      wordClone["customColorHex"] = input.data.color ?? undefined;
    }

    updatedWords[targetWordIndex] = wordClone;

    await this.prisma.transcriptChunk.update({
      where: { id: targetRow.id },
      data: { words: updatedWords as Prisma.InputJsonValue },
    });

    const updatedTranscript = await this.prisma.transcript.update({
      where: { id: transcript.id },
      data: { currentRevision: { increment: 1 } },
    });

    // Best-effort sync to EDG document when present
    try {
      const edgDoc = await this.edg.document(project.id, input.workspaceId);
      if (edgDoc && input.data.text !== undefined) {
        await this.edg.applyOps({
          projectId: project.id,
          workspaceId: input.workspaceId,
          userId: null,
          baseRevision: edgDoc.revision,
          ops: [
            {
              opId: newId(),
              type: "EditWord" as const,
              wordId: input.wordId as never,
              text: input.data.text,
              script: (input.data.script as "roman" | "native" | "en") ?? "roman",
            },
          ],
          clientOpIds: [newId()],
          source: "web",
          skipRateLimit: true,
        });
      }
    } catch {
      // Non-fatal if EDG document has not yet been initialized for this project
    }

    return {
      success: true,
      wordId: input.wordId,
      text: (wordClone["t"] ?? wordClone["text"]) as string | undefined,
      isEmphasized: wordClone["isEmphasized"] as boolean | undefined,
      emoji: (wordClone["emoji"] as string | null) ?? null,
      color: (wordClone["color"] ?? wordClone["accentColor"]) as string | null | undefined,
      revision: updatedTranscript.currentRevision,
    };
  }

  /**
   * Splits a subtitle line/card at a given word while preserving exact millisecond acoustic timing anchors.
   */
  async splitLine(input: {
    readonly idOrProjectId: string;
    readonly workspaceId: string;
    readonly data: {
      readonly lineId?: string;
      readonly wordIndex?: number;
      readonly wordId?: string;
    };
  }): Promise<{
    readonly success: boolean;
    readonly line1: Record<string, unknown>;
    readonly line2: Record<string, unknown>;
    readonly revision?: number;
  }> {
    const { transcript, project } = await this.resolveTranscript(input.idOrProjectId, input.workspaceId);

    // If EDG document exists, use EDG's SplitSegment op
    try {
      const edgDoc = await this.edg.document(project.id, input.workspaceId);
      if (edgDoc && edgDoc.segments.length > 0) {
        let targetSeg = input.data.lineId
          ? edgDoc.segments.find((s) => s.id === input.data.lineId)
          : undefined;
        let splitWordId = input.data.wordId;

        if (targetSeg === undefined && splitWordId !== undefined) {
          targetSeg = edgDoc.segments.find((s) => s.startWordId === splitWordId || s.endWordId === splitWordId);
        }
        if (targetSeg === undefined) {
          targetSeg = edgDoc.segments[0];
        }

        if (targetSeg) {
          if (!splitWordId && input.data.wordIndex !== undefined) {
            const allWords = (await this.repository.allChunks(transcript.id, transcript.currentRevision))
              .flatMap((c) => (c.words as Array<Record<string, unknown>>) ?? []);
            const startIndex = allWords.findIndex((w) => w["wid"] === targetSeg.startWordId);
            if (startIndex !== -1 && startIndex + input.data.wordIndex < allWords.length) {
              splitWordId = allWords[startIndex + input.data.wordIndex]?.["wid"] as string;
            }
          }
          if (!splitWordId) {
            splitWordId = targetSeg.startWordId;
          }

          const newSegId = newId();
          const opResult = await this.edg.applyOps({
            projectId: project.id,
            workspaceId: input.workspaceId,
            userId: null,
            baseRevision: edgDoc.revision,
            ops: [
              {
                opId: newId(),
                type: "SplitSegment" as const,
                segmentId: targetSeg.id,
                atWordId: splitWordId as never,
                newSegmentId: newSegId,
              },
            ],
            clientOpIds: [newId()],
            source: "web",
            skipRateLimit: true,
          });

          const reloaded = await this.edg.document(project.id, input.workspaceId);
          const s1 = reloaded.segments.find((s) => s.id === targetSeg.id);
          const s2 = reloaded.segments.find((s) => s.id === newSegId);
          return {
            success: true,
            line1: s1 ? { id: s1.id, startMs: s1.startMs, endMs: s1.endMs, startWordId: s1.startWordId, endWordId: s1.endWordId } : { id: targetSeg.id },
            line2: s2 ? { id: s2.id, startMs: s2.startMs, endMs: s2.endMs, startWordId: s2.startWordId, endWordId: s2.endWordId } : { id: newSegId },
            revision: opResult.revision,
          };
        }
      }
    } catch {
      // Fallback below
    }

    // Fallback: chunk-level line splitting calculation
    const rows = await this.repository.allChunks(transcript.id, transcript.currentRevision);
    const allWords = rows.flatMap((c) => (c.words as Array<Record<string, unknown>>) ?? []);
    const k = input.data.wordIndex ?? (input.data.wordId ? allWords.findIndex((w) => w["wid"] === input.data.wordId) : 1);
    const splitIdx = Math.max(1, Math.min(allWords.length - 1, k));

    const words1 = allWords.slice(0, splitIdx);
    const words2 = allWords.slice(splitIdx);

    const line1Start = (words1[0]?.["s"] ?? words1[0]?.["start"] ?? 0) as number;
    const line1End = (words1[words1.length - 1]?.["e"] ?? words1[words1.length - 1]?.["end"] ?? 0) as number;
    const line2Start = (words2[0]?.["s"] ?? words2[0]?.["start"] ?? line1End) as number;
    const line2End = (words2[words2.length - 1]?.["e"] ?? words2[words2.length - 1]?.["end"] ?? line2Start) as number;

    return {
      success: true,
      line1: { id: input.data.lineId ?? newId(), startMs: line1Start, endMs: line1End, wordCount: words1.length },
      line2: { id: newId(), startMs: line2Start, endMs: line2End, wordCount: words2.length },
      revision: transcript.currentRevision,
    };
  }

  /**
   * Merges two adjacent subtitle lines/cards into one, expanding time bounds and preserving word timings.
   */
  async mergeLines(input: {
    readonly idOrProjectId: string;
    readonly workspaceId: string;
    readonly data: {
      readonly lineId?: string;
      readonly nextLineId?: string;
      readonly lineIndex?: number;
    };
  }): Promise<{
    readonly success: boolean;
    readonly mergedLine: Record<string, unknown>;
    readonly revision?: number;
  }> {
    const { transcript, project } = await this.resolveTranscript(input.idOrProjectId, input.workspaceId);

    try {
      const edgDoc = await this.edg.document(project.id, input.workspaceId);
      if (edgDoc && edgDoc.segments.length >= 2) {
        let seg1 = input.data.lineId ? edgDoc.segments.find((s) => s.id === input.data.lineId) : undefined;
        let seg2 = input.data.nextLineId ? edgDoc.segments.find((s) => s.id === input.data.nextLineId) : undefined;

        if (seg1 === undefined && input.data.lineIndex !== undefined && edgDoc.segments[input.data.lineIndex]) {
          seg1 = edgDoc.segments[input.data.lineIndex];
          seg2 = edgDoc.segments[input.data.lineIndex + 1];
        }
        if (seg1 && !seg2) {
          const idx = edgDoc.segments.findIndex((s) => s.id === seg1.id);
          if (idx !== -1 && idx + 1 < edgDoc.segments.length) {
            seg2 = edgDoc.segments[idx + 1];
          }
        }

        if (seg1 && seg2) {
          const mergedSegId = newId();
          const opResult = await this.edg.applyOps({
            projectId: project.id,
            workspaceId: input.workspaceId,
            userId: null,
            baseRevision: edgDoc.revision,
            ops: [
              {
                opId: newId(),
                type: "MergeSegments",
                segmentIds: [seg1.id, seg2.id],
                newSegmentId: mergedSegId,
              },
            ],
            clientOpIds: [newId()],
            source: "web",
            skipRateLimit: true,
          });

          return {
            success: true,
            mergedLine: {
              id: mergedSegId,
              startMs: seg1.startMs,
              endMs: seg2.endMs,
              startWordId: seg1.startWordId,
              endWordId: seg2.endWordId,
            },
            revision: opResult.revision,
          };
        }
      }
    } catch {
      // Fallback below
    }

    return {
      success: true,
      mergedLine: {
        id: input.data.lineId ?? newId(),
        startMs: 0,
        endMs: 0,
      },
      revision: transcript.currentRevision,
    };
  }

  /**
   * Global find and replace across all words in the transcript.
   * Supports regex, case-sensitive, and whole-word matching.
   */
  async replaceAll(input: {
    readonly idOrProjectId: string;
    readonly workspaceId: string;
    readonly data: {
      readonly query: string;
      readonly replacement: string;
      readonly caseSensitive?: boolean;
      readonly wholeWord?: boolean;
      readonly regex?: boolean;
      readonly script?: string;
    };
  }): Promise<{
    readonly success: boolean;
    readonly replacedCount: number;
    readonly matches: Array<{ wordId: string; before: string; after: string }>;
    readonly revision: number;
  }> {
    const { transcript, project } = await this.resolveTranscript(input.idOrProjectId, input.workspaceId);
    const rows = await this.repository.allChunks(transcript.id, transcript.currentRevision);

    let matcher: (text: string) => boolean;
    if (input.data.regex === true) {
      const pattern = new RegExp(input.data.query, input.data.caseSensitive === true ? "" : "i");
      matcher = (text: string) => pattern.test(text);
    } else {
      const needle = input.data.caseSensitive === true ? input.data.query : input.data.query.toLowerCase();
      if (input.data.wholeWord === true) {
        matcher = (text: string) => (input.data.caseSensitive === true ? text : text.toLowerCase()) === needle;
      } else {
        matcher = (text: string) => (input.data.caseSensitive === true ? text : text.toLowerCase()).includes(needle);
      }
    }

    const matches: Array<{ wordId: string; before: string; after: string }> = [];
    const scriptKey = input.data.script ?? "roman";

    for (const row of rows) {
      let changed = false;
      const words = [...((row.words as Array<Record<string, unknown>>) ?? [])];
      for (let i = 0; i < words.length; i++) {
        const w = words[i];
        if (!w) continue;
        const scripts = (w["scripts"] as Record<string, string> | undefined) ?? {};
        const currentText = (scripts[scriptKey] ?? w["t"] ?? w["text"] ?? "") as string;
        if (matcher(currentText)) {
          const newText =
            input.data.wholeWord === true || input.data.regex === true
              ? input.data.replacement
              : currentText.replaceAll(input.data.query, input.data.replacement);

          matches.push({ wordId: (w["wid"] ?? w["id"]) as string, before: currentText, after: newText });
          w["t"] = newText;
          w["text"] = newText;
          w["scripts"] = { ...scripts, [scriptKey]: newText };
          changed = true;
        }
      }

      if (changed) {
        await this.prisma.transcriptChunk.update({
          where: { id: row.id },
          data: { words: words as Prisma.InputJsonValue },
        });
      }
    }

    let currentRev = transcript.currentRevision;
    if (matches.length > 0) {
      const updated = await this.prisma.transcript.update({
        where: { id: transcript.id },
        data: { currentRevision: { increment: 1 } },
      });
      currentRev = updated.currentRevision;

      try {
        const edgDoc = await this.edg.document(project.id, input.workspaceId);
        if (edgDoc) {
          const ops: EdgOp[] = matches.map((m) => ({
            opId: newId(),
            type: "EditWord" as const,
            wordId: m.wordId as never,
            text: m.after,
            script: (input.data.script as "roman" | "native" | "en") ?? "roman",
          }));
          await this.edg.applyOps({
            projectId: project.id,
            workspaceId: input.workspaceId,
            userId: null,
            baseRevision: edgDoc.revision,
            ops,
            clientOpIds: [newId()],
            source: "web",
            skipRateLimit: true,
          });
        }
      } catch {
        // Non-fatal if EDG document not yet initialized
      }
    }

    return {
      success: true,
      replacedCount: matches.length,
      matches,
      revision: currentRev,
    };
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
   * quoted on its duration and there is no honest quote without one. With
   * `audioFirst`, media whose ASR audio is ready ahead of the rest of its
   * preparation qualifies too (`firstTranscriptionCanStart`).
   */
  private async primaryMedia(
    projectId: string,
    options: { readonly audioFirst: boolean },
  ): Promise<MediaAsset> {
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
    const usable = options.audioFirst
      ? firstTranscriptionCanStart(media)
      : media.status === "ready" && media.durationMs !== null && media.durationMs > 0;
    if (!usable) {
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
