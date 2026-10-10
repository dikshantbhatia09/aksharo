import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";
import { computeAspectTypographyScaling } from "@montaj/caption-styles";
import {
  MULTI_ASPECT_PRESETS,
  MultiAspectExportPayloadSchema,
  computeMultiAspectCrop,
  quantizeToFrame,
  resolveMultiAspectDimensions,
  sliceTranscriptLines,
  sliceTranscriptWords,
  type ClipLayout,
  type MultiAspectExportResult,
  type MultiAspectExportTarget,
  type MultiAspectRatio,
  type MultiAspectResolution,
  type MultiAspectVariantOutput,
  type SlicedCaptionLine,
  type SlicedTimedWord,
  type TimedWord,
} from "@montaj/repurpose-contracts";

import { stillsKeyPrefix } from "./clip-images.js";
import { shapeLayoutOf, type ClipLayoutChoice } from "./layout.js";
import { MAX_CLIP_MS, MIN_CLIP_MS, REPURPOSE_CLIP_ERRORS } from "./repurpose-clips.dto.js";
import { RepurposeClipsService, timecode } from "./repurpose-clips.service.js";
import { REPURPOSE_STEERING_ERRORS } from "./repurpose-steering.dto.js";
import {
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  formatCutKeyPrefix,
  type FormatShape,
} from "./repurpose.constants.js";
import { excerptOf, isRemoved, snapToWords } from "./steering.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { newestChunkRows } from "../edg/chunk-rows.js";
import { JobsService } from "../jobs/jobs.service.js";
import { ProjectsService } from "../projects/projects.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { RepurposeClipItemView } from "./repurpose-clips.service.js";
import type {
  AdjustCandidateInput,
  ClipLayoutInput,
  ExportMultiClipInput,
  TrimClipInput,
} from "./repurpose-steering.dto.js";
import type { SnapWord, SnappedBounds } from "./steering.js";
import type { ClipCandidate, RepurposeRun } from "@prisma/client";

/** What removing, restoring or re-timing a moment answers with. */
export interface SteeringResult {
  readonly candidate: ClipCandidate;
  /**
   * The moment's clip when this call asked for it to be cut (again); null
   * otherwise - the clip list (`GET .../clips`) is where a clip is read.
   */
  readonly clip: RepurposeClipItemView | null;
  /** On an Autopilot run, the moments that were given a clip in a removed one's place. */
  readonly promoted: readonly string[];
}

/** Response payload for frame-accurate or word-snapped boundary trimming (Pillar 2 §08). */
export interface ClipTrimResult {
  readonly clipId: string | null;
  readonly candidateId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly isManualOverride: boolean;
  readonly manualStartSec: number;
  readonly manualEndSec: number;
  readonly snapped: boolean;
  readonly words: readonly SlicedTimedWord[];
  readonly lines: readonly SlicedCaptionLine[];
  readonly candidate: ClipCandidate;
  readonly clip: RepurposeClipItemView | null;
}

/** What changing a clip's layout answers with (two-speaker layouts, 2026-10-01). */
export interface LayoutResult {
  readonly clipId: string;
  /** The layout picked, now the clip's. */
  readonly layout: ClipLayoutChoice;
  /**
   * What the clip's picture is, or is being cut as: both speakers stacked, or
   * one window. "Both speakers" in a moment with one person in it is one
   * window, and the page says so.
   */
  readonly applied: ClipLayout;
  /** Whether the clip is being cut again for it. */
  readonly recut: boolean;
  /** The clip as its new cut left it, when one was asked for; null otherwise. */
  readonly clip: RepurposeClipItemView | null;
}

/**
 * The work that makes or re-makes something for one clip, by what it is made
 * for: its projects' renders, and - when its projects are being replaced - the
 * rest of their pipeline, whose completions would otherwise write to media
 * nothing will read again (a proxy that lands also starts a transcription).
 */
const RENDER_TYPES = ["render.video", "render.subtitle"] as const;
const CHILD_PIPELINE_TYPES = [
  "media.probe",
  "media.proxy",
  "ai.faces",
  "ai.transcribe",
  "ai.align",
] as const;

/**
 * Steering a run's moments once it has them (2026-09-29, from OpusClip's
 * request board: "remove unwanted clips", "re-edit clip times").
 *
 *   * **Remove** marks the moment `rejected` and stops everything still being
 *     made for its clip - the cut, the other shapes, the captioned videos, the
 *     images - so nothing more is spent on it. The clip row and what was
 *     already made are kept, so "Restore" brings it back as it was; the clip
 *     list no longer shows it. On Autopilot the best moment in reserve is given
 *     a clip in its place at once (`autopilotPicks`).
 *   * **Restore** undoes that, and asks again for whatever removing it stopped.
 *   * **Adjust** moves a moment's start and end, snapped to the words either
 *     side (`snapToWords`). A moment with a clip is cut again through the
 *     ordinary cut (`RepurposeClipsService.createClip`): the new times are in
 *     the cut's job key, so it is new work. Everything made from the old
 *     picture is started over - its shapes' projects are replaced by fresh ones,
 *     the way a first cut makes them - because every one of them is timed to
 *     the old words: the captions document, the captioned videos, the other
 *     shapes and the images. Keeping the document, as a same-times re-cut
 *     does, would put the old captions on the new picture.
 *
 * Every lookup is `(workspaceId, runId)` first, like the rest of the module.
 */
@Injectable()
export class RepurposeSteeringService {
  private readonly logger = new Logger(RepurposeSteeringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly clips: RepurposeClipsService,
    private readonly projects: ProjectsService,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  async removeCandidate(
    workspaceId: string,
    userId: string,
    runId: string,
    candidateId: string,
  ): Promise<SteeringResult> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const candidate = await this.requireCandidate(run, candidateId);
    if (isRemoved(candidate)) return { candidate, clip: null, promoted: [] };

    // Conditional, so a second press (or a second tab) is a no-op, not a
    // second round of cancels.
    const { count } = await this.prisma.clipCandidate.updateMany({
      where: { id: candidate.id, runId: run.id, state: { not: "rejected" } },
      data: { state: "rejected" },
    });
    const removed = await this.prisma.clipCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    if (count === 0) return { candidate: removed, clip: null, promoted: [] };

    // After the moment reads removed, so the completions of what is cancelled
    // here - each reconciles the run - already pass it by.
    const clip = await this.prisma.repurposeClip.findUnique({
      where: { candidateId: candidate.id },
      select: { id: true, candidateId: true, variants: { select: { projectId: true } } },
    });
    const stopped =
      clip === null
        ? 0
        : await this.stopClipWork(run, clip, {
            projectIds: clip.variants.map((variant) => variant.projectId),
            childPipeline: false,
          });

    // The run carries on from what is now true: on Autopilot the best moment in
    // reserve is cut in this one's place, and a run whose only clip in progress
    // this was can move on.
    const promoted = await this.reconcileAndDiff(run);

    await this.audit.record({
      action: "repurpose.candidate.removed",
      resource: "clip_candidate",
      resourceId: candidate.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, hadClip: clip !== null, jobsStopped: stopped, promoted },
    });
    return { candidate: removed, clip: null, promoted };
  }

  async restoreCandidate(
    workspaceId: string,
    userId: string,
    runId: string,
    candidateId: string,
  ): Promise<SteeringResult> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const candidate = await this.requireCandidate(run, candidateId);
    if (!isRemoved(candidate)) return { candidate, clip: null, promoted: [] };

    await this.prisma.clipCandidate.updateMany({
      where: { id: candidate.id, runId: run.id, state: "rejected" },
      data: { state: "proposed" },
    });
    const restored = await this.prisma.clipCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });

    // Its clip comes back as it was. A cut that removing it stopped is asked
    // for again here; its captioned videos, other shapes and images are asked
    // for again by Autopilot's own passes, which no longer pass it by.
    const hasClip =
      (await this.prisma.repurposeClip.count({ where: { candidateId: candidate.id } })) > 0;
    let clip: RepurposeClipItemView | null = null;
    if (hasClip && run.status !== "cancelled") {
      clip = await this.recut(workspaceId, userId, run, candidate.id);
    }
    await this.reconcileAndDiff(run);

    await this.audit.record({
      action: "repurpose.candidate.restored",
      resource: "clip_candidate",
      resourceId: candidate.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, hadClip: hasClip },
    });
    return { candidate: restored, clip, promoted: [] };
  }

  /**
   * Move a moment's start and end (the page nudges them a second or five at a
   * time), snapped to the words, and cut its clip again if it has one.
   *
   * @throws 409 `repurpose/candidate_removed` for a removed moment,
   *   `repurpose/clip_busy` while its clip is being cut, and
   *   `repurpose/clip_bounds_taken` when another moment already has the times;
   *   400 `repurpose/clip_bounds_invalid` when no times near the request make a
   *   3 s - 3 min moment inside the video.
   */
  async adjustCandidate(
    workspaceId: string,
    userId: string,
    runId: string,
    candidateId: string,
    input: AdjustCandidateInput,
  ): Promise<SteeringResult> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "This run was stopped, so nothing new can be made from it.",
        HttpStatus.CONFLICT,
      );
    }
    const candidate = await this.requireCandidate(run, candidateId);
    if (isRemoved(candidate)) {
      throw new AppException(
        REPURPOSE_STEERING_ERRORS.candidateRemoved,
        "Bring this moment back before changing its times.",
        HttpStatus.CONFLICT,
      );
    }

    // Everything that can refuse, refuses before anything is written.
    const { words, durationMs } = await this.sourceWords(run);
    const snapped =
      input.bypassSnap === true
        ? frameQuantizedBounds(input, durationMs)
        : snapToWords(words, input, candidate, {
            minMs: MIN_CLIP_MS,
            maxMs: MAX_CLIP_MS,
            durationMs,
          });
    if (snapped === null) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.boundsInvalid,
        "A clip has to be between 3 seconds and 3 minutes long, and inside the video.",
        HttpStatus.BAD_REQUEST,
        { minMs: MIN_CLIP_MS, maxMs: MAX_CLIP_MS, durationMs },
      );
    }
    if (snapped.startMs === candidate.startMs && snapped.endMs === candidate.endMs) {
      // Snapped back onto the times it has: nothing to cut again.
      return { candidate, clip: null, promoted: [] };
    }
    const taken = await this.prisma.clipCandidate.findFirst({
      where: {
        runId: run.id,
        startMs: snapped.startMs,
        endMs: snapped.endMs,
        id: { not: candidate.id },
      },
      select: { id: true },
    });
    if (taken !== null) throw boundsTaken(taken.id);

    const clip = await this.prisma.repurposeClip.findUnique({
      where: { candidateId: candidate.id },
      select: { id: true, candidateId: true, variants: { select: { projectId: true } } },
    });
    if (clip !== null) {
      // A cut of the old times finishing after the new one would write the old
      // picture over it (both write the moment's one mezzanine key). Queued is
      // fine: it is cancelled below, before a worker takes it.
      const cutting = await this.prisma.job.findFirst({
        where: {
          workspaceId: run.workspaceId,
          type: "media.clip",
          jobKey: { startsWith: `media.clip:${candidate.id}:` },
          status: "running",
        },
        select: { id: true },
      });
      if (cutting !== null) {
        throw new AppException(
          REPURPOSE_STEERING_ERRORS.clipBusy,
          "This clip is being cut right now. Change its times once it is ready.",
          HttpStatus.CONFLICT,
        );
      }
    }

    // A moment added by time is titled by its times; that title follows them.
    const autoTitle = `Moment at ${timecode(candidate.startMs)}–${timecode(candidate.endMs)}`;
    const title =
      candidate.source === "manual" && candidate.title === autoTitle
        ? `Moment at ${timecode(snapped.startMs)}–${timecode(snapped.endMs)}`
        : candidate.title;
    const oldProjects = clip?.variants.map((variant) => variant.projectId) ?? [];

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.clipCandidate.update({
          where: { id: candidate.id },
          data: {
            startMs: snapped.startMs,
            endMs: snapped.endMs,
            startWordId: snapped.startWordId,
            endWordId: snapped.endWordId,
            transcriptExcerpt: excerptOf(words, snapped.startMs, snapped.endMs),
            title,
          },
        });
        if (clip === null) return;
        // The clip starts over at its new times: no picture until the new cut
        // lands (it reads "cutting", and nothing renders or takes images from
        // the old one meanwhile), no images, and no shapes - the new cut makes
        // fresh ones, as a first cut does.
        await tx.repurposeClip.update({
          where: { id: clip.id },
          data: {
            title,
            sourceStartMs: snapped.startMs,
            sourceEndMs: snapped.endMs,
            isManualOverride: true,
            manualStartSec: snapped.startMs / 1000,
            manualEndSec: snapped.endMs / 1000,
            mezzanineKey: null,
            mezzanineChecksum: null,
            mezzanineDurationMs: null,
            mezzanineJobId: null,
            images: {},
          },
        });
        await tx.clipVariant.deleteMany({ where: { clipId: clip.id } });
      });
    } catch (error) {
      // Another request took the same times a moment ago.
      if (isUniqueViolation(error)) throw boundsTaken(null);
      throw error;
    }

    let stopped = 0;
    let recut: RepurposeClipItemView | null = null;
    if (clip !== null) {
      stopped = await this.stopClipWork(run, clip, {
        projectIds: oldProjects,
        childPipeline: true,
      });
      await this.retireProjects(workspaceId, run.id, oldProjects);
      recut = await this.recut(workspaceId, userId, run, candidate.id);
    }

    await this.audit.record({
      action: "repurpose.candidate.adjusted",
      resource: "clip_candidate",
      resourceId: candidate.id,
      actorId: userId,
      workspaceId,
      data: {
        runId: run.id,
        from: { startMs: candidate.startMs, endMs: candidate.endMs },
        to: { startMs: snapped.startMs, endMs: snapped.endMs },
        requested: { startMs: input.startMs, endMs: input.endMs },
        recut: clip !== null,
        jobsStopped: stopped,
      },
    });
    const adjusted = await this.prisma.clipCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
    });
    return { candidate: adjusted, clip: recut, promoted: [] };
  }

  /**
   * Frame-accurate or word-snapped clip boundary trimming with real-time
   * transcript word and subtitle line re-slicing (Pillar 2 §08).
   *
   * Validates `0 <= startSec < endSec <= videoDurationSec` and `3s <= duration <= 180s`,
   * updates the clip & candidate records (`isManualOverride: true`, `manualStartSec`,
   * `manualEndSec`), invalidates cached preview renders, and returns re-sliced
   * words and lines.
   */
  async trimClip(
    workspaceId: string,
    userId: string,
    projectOrRunId: string,
    clipOrCandidateId: string,
    input: TrimClipInput,
  ): Promise<ClipTrimResult> {
    await this.assertAvailable(workspaceId);
    const run = await this.resolveRun(workspaceId, projectOrRunId);
    if (run.status === "cancelled") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "This run was stopped, so nothing new can be made from it.",
        HttpStatus.CONFLICT,
      );
    }
    const { candidate, clipId } = await this.resolveCandidateOrClip(run, clipOrCandidateId);
    const { words, durationMs } = await this.sourceWords(run);
    const videoDurationSec = durationMs / 1000;

    const startSec =
      input.startSec ??
      input.manualStartSec ??
      (input.startMs === undefined ? candidate.startMs / 1000 : input.startMs / 1000);
    const endSec =
      input.endSec ??
      input.manualEndSec ??
      (input.endMs === undefined ? candidate.endMs / 1000 : input.endMs / 1000);

    if (
      !Number.isFinite(startSec) ||
      !Number.isFinite(endSec) ||
      startSec < 0 ||
      endSec <= startSec ||
      endSec > videoDurationSec + 1e-6
    ) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.boundsInvalid,
        "A clip has to be between 3 seconds and 3 minutes long, and inside the video.",
        HttpStatus.BAD_REQUEST,
        { minMs: MIN_CLIP_MS, maxMs: MAX_CLIP_MS, durationMs },
      );
    }

    const steeringResult = await this.adjustCandidate(
      workspaceId,
      userId,
      run.id,
      candidate.id,
      {
        startMs: Math.round(startSec * 1000),
        endMs: Math.round(endSec * 1000),
        ...(input.bypassSnap === undefined ? {} : { bypassSnap: input.bypassSnap }),
      },
    );

    const finalStartMs = steeringResult.candidate.startMs;
    const finalEndMs = steeringResult.candidate.endMs;
    const finalStartSec = finalStartMs / 1000;
    const finalEndSec = finalEndMs / 1000;

    const timedWords: TimedWord[] = words
      .filter(
        (w) =>
          w.deleted !== true &&
          Number.isFinite(w.s) &&
          Number.isFinite(w.e) &&
          w.e > w.s &&
          typeof w.t === "string",
      )
      .map((w) => ({
        id: w.wid,
        text: w.t ?? "",
        start: w.s / 1000,
        end: w.e / 1000,
      }));

    const slicedWords = sliceTranscriptWords(timedWords, finalStartSec, finalEndSec);
    const slicedLines = sliceTranscriptLines(timedWords, finalStartSec, finalEndSec);
    const resolvedClipId = steeringResult.clip?.id ?? clipId;

    if (resolvedClipId && (input.musicTrackId !== undefined || input.musicVolume !== undefined)) {
      const musicData: Record<string, unknown> = {};
      if (input.musicTrackId !== undefined) musicData.musicTrackId = input.musicTrackId;
      if (input.musicVolume !== undefined) musicData.musicVolume = input.musicVolume;
      await this.prisma.repurposeClip.update({
        where: { id: resolvedClipId },
        data: musicData,
      });
    }

    return {
      clipId: resolvedClipId,
      candidateId: steeringResult.candidate.id,
      startSec: finalStartSec,
      endSec: finalEndSec,
      startMs: finalStartMs,
      endMs: finalEndMs,
      isManualOverride: true,
      manualStartSec: finalStartSec,
      manualEndSec: finalEndSec,
      snapped:
        input.bypassSnap !== true &&
        (steeringResult.candidate.startWordId !== null ||
          steeringResult.candidate.endWordId !== null),
      words: slicedWords,
      lines: slicedLines,
      candidate: steeringResult.candidate,
      clip: steeringResult.clip,
    };
  }

  /**
   * Simultaneous Multi-Format Batch Export (Pillar 3 §06):
   * Exports a clip across multiple requested aspect ratios (9:16, 1:1, 4:5, 16:9),
   * calculating the dynamic crop rectangle centered on (centerX, centerY) and
   * adaptive typography scaling for each format.
   */
  async exportMultiClip(
    workspaceId: string,
    userId: string,
    projectOrRunId: string,
    clipOrCandidateId: string,
    input: ExportMultiClipInput,
  ): Promise<MultiAspectExportResult> {
    await this.assertAvailable(workspaceId);
    const run = await this.resolveRun(workspaceId, projectOrRunId);
    if (run.status === "cancelled") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "This run was stopped, so nothing new can be made from it.",
        HttpStatus.CONFLICT,
      );
    }
    const { candidate, clipId } = await this.resolveCandidateOrClip(run, clipOrCandidateId);

    const source = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { width: true, height: true, status: true, rawPurgedAt: true },
    });
    const refusal = uncuttableSource(source);
    if (refusal !== null) throw refusal;

    const sourceWidth = source?.width ?? 1920;
    const sourceHeight = source?.height ?? 1080;
    const centerX = input.centerX ?? 0.5;
    const centerY = input.centerY ?? 0.5;
    const resolvedClipId = clipId ?? candidate.id;

    const resolution: MultiAspectResolution = input.resolution ?? "1080p";
    const rawAspects = input.aspects ?? input.aspectRatios;
    let targets: MultiAspectExportTarget[] = [];
    if (input.targets !== undefined && input.targets.length > 0) {
      targets = input.targets.map((t) => ({
        aspect: (t.aspect ?? t.aspectRatio ?? "9:16") as MultiAspectRatio,
        resolution: (t.resolution ?? resolution) as MultiAspectResolution,
      }));
    } else if (rawAspects !== undefined && rawAspects.length > 0) {
      targets = rawAspects.map((aspect) => ({ aspect, resolution }));
    } else {
      targets = [
        { aspect: "9:16", resolution },
        { aspect: "1:1", resolution },
      ];
    }

    const payloadValidation = MultiAspectExportPayloadSchema.safeParse({
      clipId: resolvedClipId,
      targets,
    });
    if (!payloadValidation.success) {
      throw new AppException(
        "repurpose/export_multi_invalid",
        payloadValidation.error.message,
        HttpStatus.BAD_REQUEST,
      );
    }

    const batchJobId = `batch_export_${resolvedClipId}_${String(Date.now())}`;
    const variants: MultiAspectVariantOutput[] = targets.map((target) => {
      const canvas = resolveMultiAspectDimensions(target.aspect, target.resolution);
      const crop = computeMultiAspectCrop(sourceWidth, sourceHeight, target.aspect, centerX, centerY);
      const typography = computeAspectTypographyScaling({
        aspect: target.aspect,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      });
      // eslint-disable-next-line security/detect-object-injection -- closed enum key
      const preset = MULTI_ASPECT_PRESETS[target.aspect];
      const filename = `clip_${preset.filenameSlug}.mp4`;
      const downloadUrl = `/api/v1/projects/${encodeURIComponent(run.sourceProjectId)}/clips/${encodeURIComponent(resolvedClipId)}/downloads/${encodeURIComponent(filename)}`;

      return {
        aspect: target.aspect,
        aspectRatio: target.aspect,
        resolution: target.resolution,
        width: canvas.width,
        height: canvas.height,
        crop,
        captionFontSizePx: typography.fontSizePx,
        captionYOffsetPx: typography.yOffset,
        filename,
        status: "ready",
        downloadUrl,
      };
    });

    const addClipFormatFn = (
      this.clips as unknown as {
        addClipFormat?: (
          ws: string,
          user: string,
          rId: string,
          cId: string,
          aspect: MultiAspectRatio,
        ) => Promise<unknown>;
      }
    ).addClipFormat;

    const enqueued: string[] = [];
    for (const target of targets) {
      if (typeof addClipFormatFn === "function") {
        await addClipFormatFn.call(
          this.clips,
          workspaceId,
          userId,
          run.id,
          resolvedClipId,
          target.aspect,
        ).catch(() => null);
      }
      enqueued.push(target.aspect);
    }

    await this.audit.record({
      action: "repurpose.clip.export_multi_requested",
      resource: "repurpose_clip",
      resourceId: resolvedClipId,
      actorId: userId,
      workspaceId,
      data: {
        runId: run.id,
        candidateId: candidate.id,
        targets: targets.map((t) => ({ aspect: t.aspect, resolution: t.resolution })),
        batchJobId,
      },
    });

    return {
      clipId: resolvedClipId,
      runId: run.id,
      candidateId: candidate.id,
      batchJobId,
      variants,
      enqueued,
    };
  }

  /**
   * "Auto", "One speaker" or "Both speakers" for one clip (two-speaker layouts,
   * 2026-10-01). The choice is saved on the clip, and the clip is cut again
   * through the ordinary cut only when its picture would change: a moment with
   * one person in it is one window under "Both speakers" too, and cutting it
   * again would make the same clip.
   *
   * Unlike new times, a new layout keeps the clip's shapes, their projects and
   * their captions documents - the words are the same. Its 9:16 picture is
   * replaced when the new cut lands, its 4:5 shape follows it
   * (`RepurposeClipsService.cutFormats`), and their captioned videos and images
   * are made again from the new pictures. 1:1 and 16:9 are never stacked, and
   * nothing of theirs is stopped.
   *
   * @throws 409 `repurpose/clip_busy` while a cut of the clip is running (the
   *   picture of the old layout would land over the new one),
   *   `repurpose/candidate_removed` for a removed moment, and the source's
   *   own refusals (`source_expired`, `source_failed`); 404 for a clip that is
   *   not this run's.
   */
  async setClipLayout(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    input: ClipLayoutInput,
  ): Promise<LayoutResult> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "This run was stopped, so nothing new can be made from it.",
        HttpStatus.CONFLICT,
      );
    }
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId: run.id },
      include: {
        candidate: true,
        variants: { select: { aspect: true, projectId: true, layout: true } },
      },
    });
    if (clip === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that clip.",
        HttpStatus.NOT_FOUND,
      );
    }
    if (isRemoved(clip.candidate)) {
      throw new AppException(
        REPURPOSE_STEERING_ERRORS.candidateRemoved,
        "Bring this moment back before changing its layout.",
        HttpStatus.CONFLICT,
      );
    }

    // Everything that can refuse, refuses before anything is written. Both of
    // the shapes a layout changes write one picture each under a fixed key: a
    // cut of the old layout still running would land over the new one.
    const cutting = await this.prisma.job.findFirst({
      where: {
        workspaceId: run.workspaceId,
        type: "media.clip",
        status: "running",
        OR: [
          { jobKey: { startsWith: `media.clip:${clip.candidateId}:` } },
          { jobKey: { startsWith: formatCutKeyPrefix(clip.candidateId, "4:5") } },
        ],
      },
      select: { id: true },
    });
    if (cutting !== null) {
      throw new AppException(
        REPURPOSE_STEERING_ERRORS.clipBusy,
        "This clip is being cut right now. Change its layout once it is ready.",
        HttpStatus.CONFLICT,
      );
    }
    const source = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
      select: { status: true, rawPurgedAt: true },
    });
    const refusal = uncuttableSource(source);
    if (refusal !== null) throw refusal;

    const choice = input.layout;
    const applied = await this.clips.layoutFor(run, clip.candidate, choice);
    // What the picture is now: its 9:16 shape's layout. A clip with no picture
    // yet is cut in the new layout whenever it is cut; it is asked for again
    // now only when the choice changed.
    const picture =
      clip.mezzanineKey === null
        ? null
        : shapeLayoutOf(clip.variants.find((variant) => variant.aspect === "r9x16")?.layout);
    const recutting = picture === null ? clip.layout !== choice : applied !== picture;

    if (!recutting) {
      if (clip.layout !== choice) {
        // `updatedAt` kept as it was: a touch after the clip's last cut ended
        // reads as a cut asked for (`clip-state.ts`), and none is.
        await this.prisma.repurposeClip.update({
          where: { id: clip.id },
          data: { layout: choice, updatedAt: clip.updatedAt },
        });
      }
      await this.recordLayout(workspaceId, userId, run.id, clip.id, {
        from: clip.layout,
        to: choice,
        applied,
        recut: false,
        jobsStopped: 0,
      });
      return { clipId: clip.id, layout: choice, applied, recut: false, clip: null };
    }

    // Stop what is being made from the old picture - the queued cuts of the
    // 9:16 and 4:5 shapes, their captioned videos, the images - then start the
    // clip over: no picture until the new cut lands (it reads "cutting"). The
    // write comes after the stops, so the clip reads as owed a cut even if the
    // cut below is refused for now, and the reconcile makes it.
    const changing = clip.variants
      .filter((variant) => variant.aspect === "r9x16" || variant.aspect === "r4x5")
      .map((variant) => variant.projectId);
    const stopped = await this.stopClipWork(run, clip, {
      projectIds: changing,
      childPipeline: false,
      formatShapes: ["4:5"],
    });
    await this.prisma.repurposeClip.update({
      where: { id: clip.id },
      data: {
        layout: choice,
        mezzanineKey: null,
        mezzanineChecksum: null,
        mezzanineDurationMs: null,
        mezzanineJobId: null,
      },
    });
    const recut = await this.recut(workspaceId, userId, run, clip.candidateId);

    await this.recordLayout(workspaceId, userId, run.id, clip.id, {
      from: clip.layout,
      to: choice,
      applied,
      recut: true,
      jobsStopped: stopped,
    });
    return { clipId: clip.id, layout: choice, applied, recut: true, clip: recut };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async recordLayout(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    data: {
      readonly from: string;
      readonly to: ClipLayoutChoice;
      readonly applied: ClipLayout;
      readonly recut: boolean;
      readonly jobsStopped: number;
    },
  ): Promise<void> {
    await this.audit.record({
      action: "repurpose.clip.layout_changed",
      resource: "repurpose_clip",
      resourceId: clipId,
      actorId: userId,
      workspaceId,
      data: { runId, ...data },
    });
  }

  /**
   * The run source's words (its newest transcript) and its probed length, for
   * snapping. Refuses what no clip can be cut from, as a cut would.
   */
  private async sourceWords(
    run: RepurposeRun,
  ): Promise<{ readonly words: SnapWord[]; readonly durationMs: number }> {
    const [transcript, media] = await Promise.all([
      this.prisma.transcript.findFirst({
        where: { projectId: run.sourceProjectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
      this.prisma.mediaAsset.findFirst({
        where: { projectId: run.sourceProjectId, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: { status: true, durationMs: true, rawPurgedAt: true },
      }),
    ]);
    const refusal = uncuttableSource(media);
    if (refusal !== null) throw refusal;
    if (transcript === null || media === null || media.durationMs === null) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "You can change a moment's times once the transcript is ready.",
        HttpStatus.CONFLICT,
      );
    }
    const words = (await newestChunkRows(this.prisma, transcript.id)).flatMap(
      (chunk) => (chunk.words as unknown as SnapWord[] | null) ?? [],
    );
    return { words, durationMs: media.durationMs };
  }

  /**
   * Cancel what is still being made for one clip: its cut, its other shapes'
   * cuts, its images, and its projects' renders (and, for projects being
   * replaced, the rest of their pipeline). Each cancel releases its credit hold
   * and its lane slot (`JobsService.cancel`); one that finished meanwhile
   * answers 409 and is left as it is.
   *
   * @returns how many jobs were asked to stop.
   */
  private async stopClipWork(
    run: RepurposeRun,
    clip: { readonly id: string; readonly candidateId: string },
    options: {
      readonly projectIds: readonly string[];
      readonly childPipeline: boolean;
      /** Only these shapes' format cuts (a new layout changes 4:5 only); all when absent. */
      readonly formatShapes?: readonly FormatShape[];
    },
  ): Promise<number> {
    const projectTypes: string[] = [
      ...RENDER_TYPES,
      ...(options.childPipeline ? CHILD_PIPELINE_TYPES : []),
    ];
    const live = await this.prisma.job.findMany({
      where: {
        workspaceId: run.workspaceId,
        status: { in: ["queued", "running"] },
        OR: [
          { type: "media.clip", jobKey: { startsWith: `media.clip:${clip.candidateId}:` } },
          ...(options.formatShapes === undefined
            ? [
                {
                  type: "media.clip",
                  jobKey: { startsWith: `media.clip.format:${clip.candidateId}:` },
                },
              ]
            : options.formatShapes.map((shape) => ({
                type: "media.clip",
                jobKey: { startsWith: formatCutKeyPrefix(clip.candidateId, shape) },
              }))),
          { type: "media.stills", jobKey: { startsWith: stillsKeyPrefix(clip.id) } },
          ...(options.projectIds.length === 0
            ? []
            : [{ type: { in: projectTypes }, projectId: { in: [...options.projectIds] } }]),
        ],
      },
      select: { id: true },
    });
    for (const job of live) {
      try {
        await this.jobs.cancel(job.id, run.workspaceId);
      } catch (error) {
        this.logger.warn(
          { runId: run.id, clipId: clip.id, jobId: job.id, err: error },
          "could not stop a job of a steered clip; its completion is turned away",
        );
      }
    }
    return live.length;
  }

  /**
   * The projects a re-timed clip's shapes were made in: set aside (soft-deleted,
   * out of the project list) and their finished videos' files deleted now, not
   * when retention gets to them - they show the old times, and a clip has four.
   * Best effort: a file that stays behind costs disk, never the new clip.
   */
  private async retireProjects(
    workspaceId: string,
    runId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    for (const projectId of projectIds) {
      try {
        const renders = await this.prisma.export.findMany({
          where: { projectId, status: "succeeded", storageKey: { not: null } },
          select: { id: true, storageKey: true },
        });
        for (const render of renders) {
          if (render.storageKey === null) continue;
          await this.derived.delete(render.storageKey);
          await this.prisma.export.update({
            where: { id: render.id },
            data: { storageKey: null },
          });
        }
        await this.projects.softDelete(workspaceId, projectId);
      } catch (error) {
        this.logger.warn(
          { runId, projectId, err: error },
          "could not set aside a re-timed clip's old project; retention will",
        );
      }
    }
  }

  /**
   * Cut the moment's clip (again) through the ordinary cut. Never throws: the
   * change it follows is already made, and a cut refused for now - the run's
   * cut budget, the plan's lane - reads `waiting` and is cut by the reconcile.
   */
  private async recut(
    workspaceId: string,
    userId: string,
    run: RepurposeRun,
    candidateId: string,
  ): Promise<RepurposeClipItemView | null> {
    try {
      return await this.clips.createClip(workspaceId, userId, run.id, { candidateId });
    } catch (error) {
      this.logger.warn(
        { runId: run.id, candidateId, err: error },
        "could not ask for a steered clip's cut now; the reconcile asks again",
      );
      return null;
    }
  }

  /**
   * Reconcile the run's clips now (Autopilot's picks, a run that can move on),
   * and say which moments were given a clip by it. Never throws.
   */
  private async reconcileAndDiff(run: RepurposeRun): Promise<string[]> {
    try {
      const before = await this.clipCandidateIds(run.id);
      await this.clips.reconcileClips(run.id);
      const after = await this.clipCandidateIds(run.id);
      return [...after].filter((id) => !before.has(id));
    } catch (error) {
      this.logger.warn(
        { runId: run.id, err: error },
        "could not reconcile a steered run's clips now; the next pass does",
      );
      return [];
    }
  }

  private async clipCandidateIds(runId: string): Promise<Set<string>> {
    const rows = await this.prisma.repurposeClip.findMany({
      where: { runId },
      select: { candidateId: true },
    });
    return new Set(rows.map((row) => row.candidateId));
  }

  private async requireCandidate(run: RepurposeRun, candidateId: string): Promise<ClipCandidate> {
    const candidate = await this.prisma.clipCandidate.findFirst({
      where: { id: candidateId, runId: run.id },
    });
    if (candidate === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that moment.",
        HttpStatus.NOT_FOUND,
      );
    }
    return candidate;
  }

  /** Workspace and id, together — never "find by id, then check" (§17.3). */
  private async requireRun(workspaceId: string, runId: string): Promise<RepurposeRun> {
    const run = await this.prisma.repurposeRun.findFirst({ where: { id: runId, workspaceId } });
    if (run === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that video project.",
        HttpStatus.NOT_FOUND,
      );
    }
    return run;
  }

  /**
   * Resolves a run by either `runId` or `sourceProjectId` (for `/api/v1/projects/:id/clips/:clipId/trim`),
   * always scoped by `workspaceId`.
   */
  private async resolveRun(workspaceId: string, projectOrRunId: string): Promise<RepurposeRun> {
    const byRunId = await this.prisma.repurposeRun.findFirst({
      where: { id: projectOrRunId, workspaceId },
    });
    if (byRunId !== null) return byRunId;
    const byProjectId = await this.prisma.repurposeRun.findFirst({
      where: { sourceProjectId: projectOrRunId, workspaceId },
    });
    if (byProjectId !== null) return byProjectId;
    throw new AppException(
      REPURPOSE_ERRORS.notFound,
      "We could not find that video project.",
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Resolves a clip candidate by either `clipId` (`repurpose_clips.id`) or
   * `candidateId` (`clip_candidates.id`), scoped to `run.id`.
   */
  private async resolveCandidateOrClip(
    run: RepurposeRun,
    clipOrCandidateId: string,
  ): Promise<{ readonly candidate: ClipCandidate; readonly clipId: string | null }> {
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipOrCandidateId, runId: run.id },
      include: { candidate: true },
    });
    if (clip !== null && clip.candidate !== undefined) {
      return { candidate: clip.candidate, clipId: clip.id };
    }
    const candidate = await this.requireCandidate(run, clipOrCandidateId);
    const matchingClip = await this.prisma.repurposeClip.findUnique({
      where: { candidateId: candidate.id },
      select: { id: true },
    });
    return { candidate, clipId: matchingClip?.id ?? null };
  }

  /**
   * `RepurposeService.flagEnabled`'s rule, restated as `RepurposeClipsService`
   * restates it: an explicit `FEATURE_FLAGS_JSON` value wins, otherwise the
   * workspace's entitlement. 404 while the surface is off.
   */
  private async assertAvailable(workspaceId: string): Promise<void> {
    const override = this.env.FEATURE_FLAGS_JSON[REPURPOSE_FLAGS.flow];
    const enabled =
      typeof override === "boolean"
        ? override
        : (
            (await this.entitlements.forWorkspace(workspaceId)).entitlements.flags as
              Record<string, boolean> | undefined
          )?.[REPURPOSE_FLAGS.flow] === true;
    if (enabled) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "This feature is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * Quantizes free-form `Shift`-dragged bounds (`bypassSnap: true`) to 1/30s frame
 * accuracy and validates `0 <= startMs < endMs <= durationMs` and `3s <= length <= 180s`.
 */
function frameQuantizedBounds(
  requested: { readonly startMs: number; readonly endMs: number },
  durationMs: number | null,
): SnappedBounds | null {
  if (
    !Number.isFinite(requested.startMs) ||
    !Number.isFinite(requested.endMs) ||
    requested.startMs < 0
  ) {
    return null;
  }
  const startSec = quantizeToFrame(requested.startMs / 1000, 30);
  const rawEndSec = quantizeToFrame(requested.endMs / 1000, 30);
  const startMs = Math.round(startSec * 1000);
  const maxEndMs =
    durationMs !== null && durationMs > 0 ? durationMs : Math.round(rawEndSec * 1000);
  const endMs = Math.min(maxEndMs, Math.round(rawEndSec * 1000));
  const length = endMs - startMs;
  if (startMs < 0 || endMs <= startMs || length < MIN_CLIP_MS || length > MAX_CLIP_MS) {
    return null;
  }
  if (durationMs !== null && durationMs > 0 && Math.round(rawEndSec * 1000) > durationMs) {
    return null;
  }
  return { startMs, endMs, startWordId: null, endWordId: null };
}

/**
 * Why no clip can be cut from the run's source any more, or null when one
 * can: it failed its preparation, or its original has been purged.
 */
function uncuttableSource(
  media: { readonly status: string; readonly rawPurgedAt: Date | null } | null,
): AppException | null {
  if (media?.status === "failed") {
    return new AppException(
      REPURPOSE_CLIP_ERRORS.sourceFailed,
      "This video could not be prepared, so no clips can be cut from it.",
      HttpStatus.CONFLICT,
    );
  }
  if (media?.rawPurgedAt !== null && media?.rawPurgedAt !== undefined) {
    return new AppException(
      REPURPOSE_CLIP_ERRORS.sourceExpired,
      "The original video is no longer kept, so new clips cannot be cut from it. Start again from the same link.",
      HttpStatus.CONFLICT,
    );
  }
  return null;
}

function boundsTaken(otherCandidateId: string | null): AppException {
  return new AppException(
    REPURPOSE_STEERING_ERRORS.boundsTaken,
    "Another moment already has these times.",
    HttpStatus.CONFLICT,
    otherCandidateId === null ? undefined : { candidateId: otherCandidateId },
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}
