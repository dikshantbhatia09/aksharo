import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import { newId } from "@montaj/edg";
import type { Pass } from "@montaj/edg/schemas";

import {
  PASS_ERROR_CODES,
  type AutocutPreset,
  type ReframeAspect,
  type ZoomPreset,
} from "./passes.errors.js";
import { quoteAutocut, quoteReframeZoom, quoteSfx, quoteTextFx } from "./passes.quote.js";
import { assetAllowed, AudioAssetsRepository } from "../audio-assets/index.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { EdgService } from "../edg/index.js";
import { JobsService } from "../jobs/jobs.service.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";
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
 * ### Protection (B18b)
 *
 * `protectedRanges` carries the user-marked `EdgHot.protected[]` set (written by
 * `SetProtectedRanges`, CONTRACTS §2) *plus* the implicit ranges derived from
 * segments carrying `emphasis` or `textOverrides` — the guard `Segment` itself
 * can express. `guardedRanges` keeps sending the implicit half alone, for
 * whoever still reads it. Every `ai.pass` is refused an item inside either.
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

export interface StartTextFxRequest {
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface StartTextFxAccepted {
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

export interface StartSfxRequest {
  readonly projectId: string;
  readonly workspaceId: string;
}

export interface StartSfxAccepted {
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
    private readonly audioAssets: AudioAssetsRepository,
  ) {}

  /** `POST /projects/{id}/passes/autocut`. */
  async startAutocut(request: StartAutocutRequest): Promise<StartAutocutAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);
    const transcript = await this.transcriptOf(project.id);

    const quote = quoteAutocut(media.durationMs ?? 0);
    const passId = newId();
    const words = await this.wordsOf(transcript);
    const storedProtected = await this.storedProtectedRangesOf(project.id, request.workspaceId);
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
        protectedRanges: [...storedProtected, ...guardedRanges],
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
   * `POST /projects/{id}/passes/zoom` (B19 §3, frame/RMS sampling wired B19b).
   *
   * Emphasis-word cues come from the live document's segments (`Segment.
   * emphasis`, CONTRACTS §2), timestamped by the emphasised word's own `s`
   * (word timing) — `emphasisCuesOf` resolves each `wordId` against the
   * transcript's current revision (B19b ruling 5; B19 approximated this as
   * the segment's `startMs`).
   *
   * Real audio-energy cues and real subject detections need decoded video
   * frames and audio; B19b wires this by having the worker sample the 540p
   * proxy itself (`worker_ai.processors.reframe_zoom_pass._sample_from_proxy`)
   * rather than this producer decoding media, so `rmsSamples`/`detections`/
   * `sceneFrames` are sent empty here on purpose — an empty list is the
   * worker's signal to sample (`_payload_needs_sampling`). `proxyRequired`
   * below rejects the request outright when there is no proxy to sample.
   */
  async startZoom(request: StartZoomRequest): Promise<StartReframeZoomAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);
    this.requireProxy(media);

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
   * `POST /projects/{id}/passes/reframe` (B19 §4, frame sampling wired B19b).
   *
   * Same as `startZoom`: `detections`/`sceneFrames` are sent empty on
   * purpose, so the worker samples the proxy itself; `requireProxy` rejects
   * the request outright when the project has none to sample.
   */
  async startReframe(request: StartReframeRequest): Promise<StartReframeZoomAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);
    this.requireProxy(media);

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

  /**
   * `POST /projects/{id}/passes/textfx` (D06 §6): key-phrase title
   * extraction. Unlike `zoom`/`reframe`, this needs no media proxy — the
   * `keyphrases@1` prompt only reads the transcript's own segments — so it
   * only needs a transcript, same as `startAutocut`.
   *
   * Quoted on the **finished** timeline (`quoteTextFx`, `textFxPass` basis
   * `finishedMinute` — D07's principle that a pass reading the post-cut
   * result settles on it): `media.durationMs` minus every accepted `cut`
   * item's own range, floored at 0 so a fully-cut (degenerate) timeline still
   * quotes the one-quantum minimum `deciMinutes` already guarantees.
   */
  async startTextFx(request: StartTextFxRequest): Promise<StartTextFxAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);
    const transcript = await this.transcriptOf(project.id);

    const cutRanges = await this.acceptedCutRangesOf(project.id, request.workspaceId);
    const removedMs = cutRanges.reduce((total, [s, e]) => total + Math.max(0, e - s), 0);
    const finishedDurationMs = Math.max(0, (media.durationMs ?? 0) - removedMs);

    const quote = quoteTextFx(finishedDurationMs);
    const passId = newId();
    const segments = await this.segmentsForTextFx(transcript);
    const words = await this.wordsOf(transcript);
    const storedProtected = await this.storedProtectedRangesOf(project.id, request.workspaceId);
    const guardedRanges = await this.guardedRangesOf(project.id, request.workspaceId);

    const jobKey = `ai.pass:textfx:${project.id}`;
    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.pass",
      workspaceId: request.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        passId,
        passType: "textfx",
        language: transcript.language,
        durationMs: media.durationMs,
        mediaId: media.id,
        segments,
        words: words.map((word) => [word.wid, word.s, word.e, word.t]),
        cutRanges,
        protectedRanges: [...storedProtected, ...guardedRanges],
      },
    });

    this.logger.log(
      { projectId: project.id, jobId: job.id, passId, tenths: quote.tenths, deduplicated },
      "textfx pass enqueued",
    );

    return {
      jobId: job.id,
      passId: deduplicated ? (passIdOf(job.params) ?? passId) : passId,
      status: job.status,
      deduplicated,
      quote: { tenths: quote.tenths, credits: quote.credits, durationMs: finishedDurationMs },
    };
  }

  /**
   * `POST /projects/{id}/passes/sfx` (D04c, following D04a's cue-detection/
   * retrieval build): quotes on the **finished** timeline (`quoteSfx`, same
   * D07 basis `startTextFx` uses), holds credits and enqueues `ai.pass` with
   * everything `worker_ai.passes.sfx.build_sfx_items` needs — the worker is
   * stateless (no DB, no queue), so the whole licence-allowed catalogue,
   * already narrowed by `assetAllowed` here, rides in the job payload rather
   * than the worker querying Postgres itself (`audio-assets/README.md`'s "What
   * is NOT here" list, now built).
   *
   * `rmsSamples` still rides empty here, same as `zoom`/`reframe`'s payload
   * (`startZoom`/`startReframe` above) — the worker, not this producer,
   * downloads and decodes the proxy when it sees an empty array
   * (`worker_ai.processors.sfx_pass._needs_rms_sampling`, D04d, generalised
   * from B19b's `reframe_zoom_pass._payload_needs_sampling` via the shared
   * `worker_ai.processors.proxy_media.download_proxy` helper). So energy
   * cues do fire now, on the same 10 Hz RMS windows `zoom`/`reframe` use.
   */
  async startSfx(request: StartSfxRequest): Promise<StartSfxAccepted> {
    const project = await this.project(request.projectId, request.workspaceId);
    const media = await this.primaryMedia(project.id);
    const transcript = await this.transcriptOf(project.id);

    const cutRanges = await this.acceptedCutRangesOf(project.id, request.workspaceId);
    const removedMs = cutRanges.reduce((total, [s, e]) => total + Math.max(0, e - s), 0);
    const finishedDurationMs = Math.max(0, (media.durationMs ?? 0) - removedMs);

    const quote = quoteSfx(finishedDurationMs);
    const passId = newId();
    const words = await this.wordsOf(transcript);
    const sentences = await this.segmentsForTextFx(transcript);
    const emphasisWords = await this.sfxEmphasisCuesOf(project.id, request.workspaceId, words);
    const speechRanges = speechRangesFromWords(words, media.durationMs ?? 0);
    const storedProtected = await this.storedProtectedRangesOf(project.id, request.workspaceId);
    const guardedRanges = await this.guardedRangesOf(project.id, request.workspaceId);
    const catalogue = await this.sfxCatalogueOf(request.workspaceId);

    const jobKey = `ai.pass:sfx:${project.id}`;
    const { job, deduplicated } = await this.jobs.enqueue({
      type: "ai.pass",
      workspaceId: request.workspaceId,
      projectId: project.id,
      jobKey,
      worstCaseTenths: quote.tenths,
      reason: quote.reason,
      params: {
        passId,
        passType: "sfx",
        durationMs: media.durationMs,
        mediaId: media.id,
        sentences,
        emphasisWords,
        speechRanges,
        rmsSamples: [],
        cutRanges,
        protectedRanges: [...storedProtected, ...guardedRanges],
        catalogue,
      },
    });

    this.logger.log(
      { projectId: project.id, jobId: job.id, passId, tenths: quote.tenths, deduplicated },
      "sfx pass enqueued",
    );

    return {
      jobId: job.id,
      passId: deduplicated ? (passIdOf(job.params) ?? passId) : passId,
      status: job.status,
      deduplicated,
      quote: { tenths: quote.tenths, credits: quote.credits, durationMs: finishedDurationMs },
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
   * One `{startMs, endMs, text, speaker?}` row per transcript chunk (same
   * shape and grouping `apps/api/src/insights/insights.service.ts`'s own
   * `segmentOf` builds for the chapters/summary/hooks prompts) — the
   * `keyphrases@1` prompt's transcript block, PII-minimised the same way
   * (text and timestamps only, never a user id or name).
   */
  private async segmentsForTextFx(
    transcript: Transcript,
  ): Promise<{ startMs: number; endMs: number; text: string; speaker?: string }[]> {
    const rows = await this.transcripts.allChunks(transcript.id, transcript.currentRevision);
    const segments: { startMs: number; endMs: number; text: string; speaker?: string }[] = [];
    for (const row of rows) {
      const words = (
        row.words as unknown as { t: string; sp?: string; deleted?: boolean }[]
      ).filter((word) => word.deleted !== true);
      const text = words
        .map((word) => word.t)
        .join(" ")
        .trim();
      if (text === "") continue;
      const speaker = words.find((word) => word.sp !== undefined)?.sp;
      segments.push({
        startMs: row.startMs,
        endMs: row.endMs,
        text,
        ...(speaker === undefined ? {} : { speaker }),
      });
    }
    return segments;
  }

  /**
   * The user-marked ranges stored on `EdgHot.protected` (`SetProtectedRanges`,
   * CONTRACTS §2). Empty when the document has no live EDG yet.
   */
  private async storedProtectedRangesOf(
    projectId: string,
    workspaceId: string,
  ): Promise<[number, number][]> {
    try {
      const { hot } = await this.edg.document(projectId, workspaceId);
      return (hot.protected ?? []).map((range) => [range.s, range.e]);
    } catch {
      return []; // `edg/not_initialised`: no live document yet, nothing stored.
    }
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
   * Emphasis-word cues for the zoom pass, one per emphasised word, timestamped
   * by the word's own `s` (start, ms) — B19b ruling 5. `wordId`s are resolved
   * against the project's transcript at its current revision; a segment whose
   * `emphasis[].wordId` cannot be found (a stale reference after a delete)
   * contributes no cue rather than failing the whole pass.
   */
  private async emphasisCuesOf(projectId: string, workspaceId: string): Promise<{ tMs: number }[]> {
    let transcript: Transcript;
    try {
      transcript = await this.transcriptOf(projectId);
    } catch {
      return []; // no transcript yet: no words to resolve, no cues.
    }
    const wordStartByWid = new Map<string, number>();
    for (const word of await this.wordsOf(transcript)) {
      wordStartByWid.set(word.wid, word.s);
    }

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
        for (const emphasis of segment.emphasis ?? []) {
          const startMs = wordStartByWid.get(emphasis.wordId);
          if (startMs !== undefined) cues.push({ tMs: startMs });
        }
      }
      if (page.nextCursor === null) return cues;
      cursor = page.nextCursor;
    }
  }

  /**
   * Emphasis-word cues for the sfx pass (D04c): same word set `emphasisCuesOf`
   * resolves for `zoom`, but carrying the word's own text too, since `sfx.py`'s
   * `detect_emphasis_cues` wants `(t_ms, word_text)` pairs to build its
   * retrieval query from.
   */
  private async sfxEmphasisCuesOf(
    projectId: string,
    workspaceId: string,
    words: { wid: string; s: number; t: string }[],
  ): Promise<{ tMs: number; text: string }[]> {
    const wordByWid = new Map(words.map((word) => [word.wid, word]));
    const cues: { tMs: number; text: string }[] = [];
    let cursor: string | undefined;
    for (;;) {
      let page;
      try {
        page = await this.edg.segments(projectId, workspaceId, cursor, 1_000);
      } catch {
        return []; // `edg/not_initialised`: no live document yet, no cues.
      }
      for (const segment of page.segments) {
        for (const emphasis of segment.emphasis ?? []) {
          const word = wordByWid.get(emphasis.wordId);
          if (word !== undefined) cues.push({ tMs: word.s, text: word.t });
        }
      }
      if (page.nextCursor === null) return cues;
      cursor = page.nextCursor;
    }
  }

  /**
   * The whole licence-allowed `sfx` catalogue for this workspace, ready for
   * `worker_ai.passes.sfx.build_sfx_items`'s `CatalogueAsset` list.
   * `assetAllowed` runs here (surface `cloud_render` — this pass proposes
   * cues for a cloud-composited timeline, not a raw NLE delivery; territory
   * `"WORLD"` until a workspace-level territory signal exists, flagged as an
   * assumption in the final report) so a partner-catalogue asset the plan or
   * clearance state does not allow never reaches the worker, let alone a user.
   */
  private async sfxCatalogueOf(workspaceId: string): Promise<
    {
      id: string;
      packId: string;
      cueType: string | null;
      tags: string[];
      embedding: readonly number[];
      licenceSnapshot: Record<string, unknown>;
    }[]
  > {
    const plan = await resolveWorkspacePlan(this.prisma, workspaceId);
    const rows = await this.audioAssets.findCatalogueWithEmbeddings("sfx");
    return rows
      .filter(
        (row) =>
          assetAllowed(row, { surface: "cloud_render", plan, territory: "WORLD" }).allowed &&
          row.storageKey !== null &&
          row.packId !== null,
      )
      .map((row) => ({
        id: row.id,
        packId: row.packId as string,
        cueType: row.cueType,
        tags: row.tags,
        embedding: row.embedding,
        licenceSnapshot: row.licenceSnapshot,
      }));
  }

  /**
   * `passes/proxy_required` (B19b ruling 2/4): `zoom`/`reframe` sample the
   * 540p proxy for frames and audio, so a project whose primary media has no
   * proxy yet cannot run either pass.
   */
  private requireProxy(media: MediaAsset): void {
    if (media.proxyKey === null || media.proxyKey === "") {
      throw new AppException(
        PASS_ERROR_CODES.proxyRequired,
        "This project's media has no proxy yet; zoom and reframe need one to sample frames from.",
        HttpStatus.CONFLICT,
        { mediaId: media.id },
      );
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

/**
 * Where speech actually is, approximated from word timing alone (no VAD, no
 * proxy decode): consecutive words closer than `MERGE_GAP_MS` apart are
 * merged into one region — the same fallback shape `worker_ai.processors.
 * autocut_pass._regions_from_words` uses when no media is available to
 * sample. `sfx.py`'s `detect_silence_gap_cues` reads the *gaps between*
 * these regions as transition-beat cues.
 */
const MERGE_GAP_MS = 160;

function speechRangesFromWords(
  words: { s: number; e: number }[],
  durationMs: number,
): [number, number][] {
  if (words.length === 0) return [];
  const ordered = [...words].sort((a, b) => a.s - b.s);
  const regions: [number, number][] = [];
  let start = ordered[0]?.s ?? 0;
  let end = ordered[0]?.e ?? 0;
  for (const word of ordered.slice(1)) {
    if (word.s - end <= MERGE_GAP_MS) {
      end = Math.max(end, word.e);
    } else {
      regions.push([start, Math.min(end, durationMs)]);
      start = word.s;
      end = word.e;
    }
  }
  regions.push([start, Math.min(end, durationMs)]);
  return regions;
}
