import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import type { Env } from "@montaj/config";

import { stillsKeyPrefix } from "./clip-images.js";
import { MAX_CLIP_MS, MIN_CLIP_MS, REPURPOSE_CLIP_ERRORS } from "./repurpose-clips.dto.js";
import { RepurposeClipsService, timecode } from "./repurpose-clips.service.js";
import { REPURPOSE_STEERING_ERRORS } from "./repurpose-steering.dto.js";
import { REPURPOSE_ERRORS, REPURPOSE_FLAGS } from "./repurpose.constants.js";
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
import type { AdjustCandidateInput } from "./repurpose-steering.dto.js";
import type { SnapWord } from "./steering.js";
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
    const snapped = snapToWords(words, input, candidate, {
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

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

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
    if (media?.status === "failed") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.sourceFailed,
        "This video could not be prepared, so no clips can be cut from it.",
        HttpStatus.CONFLICT,
      );
    }
    if (media?.rawPurgedAt !== null && media?.rawPurgedAt !== undefined) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.sourceExpired,
        "The original video is no longer kept, so new clips cannot be cut from it. Start again from the same link.",
        HttpStatus.CONFLICT,
      );
    }
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
    options: { readonly projectIds: readonly string[]; readonly childPipeline: boolean },
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
          { type: "media.clip", jobKey: { startsWith: `media.clip.format:${clip.candidateId}:` } },
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
