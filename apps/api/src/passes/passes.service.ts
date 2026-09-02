import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { newId } from "@montaj/edg";
import type { Pass } from "@montaj/edg/schemas";

import {
  PASS_ERROR_CODES,
  type AutocutPreset,
  type ReframeAspect,
  type ZoomPreset,
} from "./passes.errors.js";
import { quoteAutocut, quoteReframeZoom } from "./passes.quote.js";
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

export interface StartZoomRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly preset: ZoomPreset;
}

export interface StartReframeRequest {
  readonly projectId: string;
  readonly workspaceId: string;
  readonly aspect: ReframeAspect;
  readonly options?: {
    readonly deadzoneFraction?: number;
    readonly maxVelocityPerS?: number;
  };
}

export interface StartReframeZoomAccepted {
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

  /**
   * `POST /projects/{id}/passes/zoom` (B19 §3).
   *
   * Emphasis-word cues come from the live document's segments (`Segment.
   * emphasis`, CONTRACTS §2); a cue's timestamp is approximated as its
   * segment's `startMs` rather than the emphasised word's own timing, since
   * resolving a `wordId` back to milliseconds needs a transcript-chunk lookup
   * this producer does not otherwise do (flagged in the final report).
   *
   * Real audio-energy cues and real subject detections need decoded audio
   * and video frames respectively; neither is wired in this work package
   * (`apps/worker-ai/worker_ai/passes/README.md`'s "Gap" note), so
   * `rmsSamples`/`detections`/`sceneFrames` are sent empty. The worker still
   * runs correctly on emphasis-only cues with a saliency-centre (0.5, 0.5)
   * target; a follow-up work package that wires A07 frame extraction into
   * this producer closes the gap without changing the worker.
   */
  async startZoom(request: StartZoomRequest): Promise<StartReframeZoomAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);

    const quote = quoteReframeZoom("zoom", media.durationMs ?? 0);
    const passId = newId();
    const emphasisWords = await this.emphasisCuesOf(project.id, request.workspaceId);
    const cutRanges = await this.acceptedCutRangesOf(project.id, request.workspaceId);

    const jobKey = `ai.pass:zoom:${project.id}`;
    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.pass",
      workspaceId: request.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        passId,
        passType: "zoom",
        preset: request.preset,
        durationMs: media.durationMs,
        mediaId: media.id,
        emphasisWords,
        rmsSamples: [],
        words: [],
        sceneFrames: [],
        detections: [],
        cutRanges,
        protectedRanges: [],
      },
    });

    this.logger.log(
      { projectId: project.id, jobId: job.id, passId, tenths: quote.tenths, deduplicated },
      "zoom pass enqueued",
    );

    return {
      jobId: job.id,
      passId: deduplicated ? (passIdOf(job.params) ?? passId) : passId,
      status: job.status,
      deduplicated,
      quote: { tenths: quote.tenths, credits: quote.credits, durationMs: quote.durationMs },
    };
  }

  /**
   * `POST /projects/{id}/passes/reframe` (B19 §4).
   *
   * Same gap as `startZoom`: real subject detections need decoded video
   * frames, not wired in this work package, so `detections` is sent empty
   * and the worker fails the job non-retryably (`worker/invalid_payload`) —
   * a documented limitation, not a silent no-op, until a follow-up work
   * package wires A07 frame extraction into this producer.
   */
  async startReframe(request: StartReframeRequest): Promise<StartReframeZoomAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);

    const quote = quoteReframeZoom("reframe", media.durationMs ?? 0);
    const passId = newId();
    const targetAspect = request.aspect === "1:1" ? 1 : 9 / 16;

    const jobKey = `ai.pass:reframe:${project.id}`;
    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.pass",
      workspaceId: request.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        passId,
        passType: "reframe",
        durationMs: media.durationMs,
        mediaId: media.id,
        sourceAspect: 16 / 9,
        targetAspect,
        deadzoneFraction: request.options?.deadzoneFraction,
        maxVelocityPerS: request.options?.maxVelocityPerS,
        detections: [],
        sceneFrames: [],
      },
    });

    this.logger.log(
      { projectId: project.id, jobId: job.id, passId, tenths: quote.tenths, deduplicated },
      "reframe pass enqueued",
    );

    return {
      jobId: job.id,
      passId: deduplicated ? (passIdOf(job.params) ?? passId) : passId,
      status: job.status,
      deduplicated,
      quote: { tenths: quote.tenths, credits: quote.credits, durationMs: quote.durationMs },
    };
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

  /**
   * Emphasis-word cues for the zoom pass, one per emphasised segment
   * (`{tMs}`, the segment's own `startMs` — see `startZoom`'s docstring for
   * why this is an approximation of the emphasised word's own timing).
   */
  private async emphasisCuesOf(projectId: string, workspaceId: string): Promise<{ tMs: number }[]> {
    const cues: { tMs: number }[] = [];
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await this.edg.segments(projectId, workspaceId, cursor, 1_000);
      } catch {
        return []; // `edg/not_initialised`: no live document yet, no cues.
      }
      for (const segment of page.segments) {
        if (Array.isArray(segment.emphasis) && segment.emphasis.length > 0) {
          cues.push({ tMs: segment.startMs });
        }
      }
      if (page.nextCursor === null) return cues;
      cursor = page.nextCursor;
    }
  }

  /**
   * Millisecond ranges of every accepted `cut` pass item — the zoom pass must
   * never place an event across one of these (brief §3).
   */
  private async acceptedCutRangesOf(
    projectId: string,
    workspaceId: string,
  ): Promise<[number, number][]> {
    let passes: Pass[];
    try {
      passes = await this.edg.passes(projectId, workspaceId);
    } catch {
      return [];
    }
    const ranges: [number, number][] = [];
    for (const pass of passes) {
      for (const item of pass.items) {
        if (item.kind === "cut" && item.state === "accepted") {
          ranges.push([item.startMs, item.endMs]);
        }
      }
    }
    return ranges;
  }
}

function passIdOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as Record<string, unknown>)["passId"];
  return typeof value === "string" && value !== "" ? value : undefined;
}
