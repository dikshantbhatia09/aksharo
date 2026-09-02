import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { newId } from "@montaj/edg";
import type { Pass } from "@montaj/edg/schemas";

import { PASS_ERROR_CODES, type AutocutPreset } from "./passes.errors.js";
import { quoteAutocut } from "./passes.quote.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgService } from "../edg/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { TranscriptsRepository } from "../transcripts/transcripts.repository.js";

import type { MediaAsset, Project, Transcript } from "@prisma/client";

/**
 * The autocut producer (B18): quote, enqueue `ai.pass`, read passes back.
 *
 * ### Producing
 *
 * ```
 * project + primary media, probed?      → pass/media_not_ready otherwise
 * transcript, at its current revision   → pass/transcript_not_ready otherwise
 * quote from packages/config             (autocutPass: source minutes)
 * mint passId                            (MergePass lands it under this id)
 * guarded ranges                         (segments with emphasis/textOverrides)
 * JobsService.enqueue                    (admission → row → reserve → BullMQ)
 * ```
 *
 * The `edg_passes`/`edg_pass_items` rows are **not** created here — `A12`'s
 * `MergePass` op creates them atomically, in one transaction, once the worker's
 * completion lands (`passes-completion.handler.ts`), the same reason
 * `TranscriptsService` mints a `transcriptId` and writes nothing: a queued pass
 * that fails, is cancelled or times out must not leave a row a reader has to
 * learn to ignore.
 *
 * ### Protection facts (CONTRACTS gap — see the final report)
 *
 * `EdgHot.protected[]`, the user-marked protected-range list the brief names,
 * does not exist in `packages/edg`'s frozen `EdgHot` (`docs/CONTRACTS.md §2`).
 * `protectedRanges` is therefore always sent empty; the guard the worker *can*
 * honour today is "never cut a segment carrying `emphasis` or
 * `textOverrides`" (CONTRACTS §2, `Segment`), which this service computes from
 * the live document and sends as `guardedRanges`.
 */

export interface StartAutocutRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly preset: AutocutPreset;
  readonly options?: {
    readonly minSilenceMs?: number;
    readonly paddingMs?: number;
    readonly maxRemovalRatio?: number;
  };
}

export interface StartAutocutAccepted {
  readonly jobId: string;
  readonly passId: string;
  readonly status: string;
  readonly deduplicated: boolean;
  readonly quote: {
    readonly tenths: number;
    readonly credits: string;
    readonly durationMs: number;
  };
}

@Injectable()
export class PassesService {
  private readonly logger = new Logger(PassesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly edg: EdgService,
    private readonly transcripts: TranscriptsRepository,
  ) {}

  /** `POST /projects/{id}/passes/autocut`. */
  async startAutocut(request: StartAutocutRequest): Promise<StartAutocutAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);
    const transcript = await this.transcriptOf(project.id);

    const quote = quoteAutocut(media.durationMs ?? 0);
    const passId = newId();
    const words = await this.wordsOf(transcript);
    const guardedRanges = await this.guardedRangesOf(project.id, request.workspaceId);

    const jobKey = `ai.pass:autocut:${project.id}`;
    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.pass",
      workspaceId: request.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        passId,
        passType: "autocut",
        preset: request.preset,
        language: transcript.language,
        durationMs: media.durationMs,
        mediaId: media.id,
        words,
        ...(request.options === undefined ? {} : { options: request.options }),
        protectedRanges: [],
        guardedRanges,
      },
    });

    this.logger.log(
      { projectId: project.id, jobId: job.id, passId, tenths: quote.tenths, deduplicated },
      "autocut pass enqueued",
    );

    return {
      jobId: job.id,
      passId: deduplicated ? (passIdOf(job.params) ?? passId) : passId,
      status: job.status,
      deduplicated,
      quote: { tenths: quote.tenths, credits: quote.credits, durationMs: quote.durationMs },
    };
  }

  /** `GET /projects/{id}/passes` — every landed pass and its items. */
  async list(projectId: string, workspaceId: string): Promise<Pass[]> {
    await this.project(projectId, workspaceId);
    return this.edg.passes(projectId, workspaceId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async project(projectId: string, workspaceId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, workspaceId, deletedAt: null },
    });
    if (project === null) {
      throw new AppException(ERROR_CODES.notFound, "No such project.", HttpStatus.NOT_FOUND);
    }
    return project;
  }

  private async primaryMedia(projectId: string): Promise<MediaAsset> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });
    if (
      media === null ||
      media.status !== "ready" ||
      media.durationMs === null ||
      media.durationMs <= 0
    ) {
      throw new AppException(
        PASS_ERROR_CODES.mediaNotReady,
        "This project's media is not ready for an autocut pass.",
        HttpStatus.CONFLICT,
        { projectId },
      );
    }
    return media;
  }

  private async transcriptOf(projectId: string): Promise<Transcript> {
    const transcript = await this.prisma.transcript.findFirst({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
    if (transcript === null) {
      throw new AppException(
        PASS_ERROR_CODES.transcriptNotReady,
        "This project has no transcript yet; autocut needs one to reason about.",
        HttpStatus.CONFLICT,
        { projectId },
      );
    }
    return transcript;
  }

  /** Every word of the transcript's current revision, flattened and wire-shaped. */
  private async wordsOf(
    transcript: Transcript,
  ): Promise<{ wid: string; s: number; e: number; t: string; filler?: boolean }[]> {
    const rows = await this.transcripts.allChunks(transcript.id, transcript.currentRevision);
    const words: { wid: string; s: number; e: number; t: string; filler?: boolean }[] = [];
    for (const row of rows) {
      const chunkWords = row.words as unknown as {
        wid: string;
        s: number;
        e: number;
        t: string;
        filler?: boolean;
        deleted?: boolean;
      }[];
      for (const word of chunkWords) {
        if (word.deleted === true) continue;
        words.push({
          wid: word.wid,
          s: word.s,
          e: word.e,
          t: word.t,
          ...(word.filler === undefined ? {} : { filler: word.filler }),
        });
      }
    }
    return words;
  }

  /**
   * Millisecond ranges of every live segment carrying `emphasis` or
   * `textOverrides` — the one protection guard `Segment` (CONTRACTS §2) can
   * actually express today.
   */
  private async guardedRangesOf(
    projectId: string,
    workspaceId: string,
  ): Promise<[number, number][]> {
    const ranges: [number, number][] = [];
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await this.edg.segments(projectId, workspaceId, cursor, 1_000);
      } catch {
        return []; // `edg/not_initialised`: no live document yet, nothing to guard.
      }
      for (const segment of page.segments) {
        const hasEmphasis = Array.isArray(segment.emphasis) && segment.emphasis.length > 0;
        const hasOverrides =
          segment.textOverrides !== undefined && Object.keys(segment.textOverrides).length > 0;
        if (hasEmphasis || hasOverrides) ranges.push([segment.startMs, segment.endMs]);
      }
      if (page.nextCursor === null) return ranges;
      cursor = page.nextCursor;
    }
  }
}

function passIdOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)["passId"];
  return typeof value === "string" && value !== "" ? value : undefined;
}
