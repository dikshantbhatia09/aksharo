import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";
import type { Word } from "@montaj/edg/schemas";
import type { FaceTrackDocument } from "@montaj/render-core";
import {
  MediaClipPayloadSchema,
  REPURPOSE_SCHEMA_VERSION,
  clipMasterKey,
  mediaClipJobKey,
} from "@montaj/repurpose-contracts";

import {
  CLIP_CHILD_VARIANTS,
  type ClipRowWithChild,
  type ClipState,
  type LatestClipJob,
  clipFactsOf,
  clipStateOf,
  cutRequestedSince,
  isLiveJob,
  latestClipJobs,
  settleRunAfterClips,
  sourceRawPurged,
  stalledCode,
} from "./clip-state.js";
import { loadFaceTrack, reframeFromTrack } from "./reframe.js";
import {
  CLIP_HANDLE_MS,
  CLIP_MAX_HEIGHT,
  CLIP_RUN_BUCKET,
  MAX_CLIPS_PER_RUN,
  MAX_CLIP_MS,
  MAX_MANUAL_CANDIDATES_PER_RUN,
  MIN_CLIP_MS,
  REPURPOSE_CLIP_ERRORS,
} from "./repurpose-clips.dto.js";
import {
  CLIP_PROFILE_VERSION,
  RECONCILE_INTERVAL_MS,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
} from "./repurpose.constants.js";
import { progressForStatus, projectRun, stageForStatus } from "./repurpose.projection.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, ERROR_CODES, PrismaService, RateLimitService } from "../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { newestChunkRows } from "../edg/chunk-rows.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { JobsService } from "../jobs/jobs.service.js";
import { FacesTrigger } from "../media/faces.js";
import { workspaceRoom } from "../realtime/realtime.protocol.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { AddCandidateInput, CreateClipInput } from "./repurpose-clips.dto.js";
import type {
  ClipCandidate,
  MediaAsset,
  Prisma,
  RepurposeClip,
  RepurposeRun,
} from "@prisma/client";

/**
 * A clip as `GET .../clips` returns it: every column and relation the page
 * already reads, plus its derived state and a short-lived mezzanine URL.
 */
export interface RepurposeClipItemView {
  readonly id: string;
  readonly candidateId: string;
  readonly state: ClipState;
  readonly failureCode: string | null;
  readonly mezzanineUrl: string | null;
  readonly [field: string]: unknown;
}

const CLIP_INCLUDE = {
  candidate: true,
  variants: {
    include: {
      project: {
        include: {
          mediaAssets: true,
          exports: { orderBy: { createdAt: "desc" } },
        },
      },
    },
  },
} as const satisfies Prisma.RepurposeClipInclude;

type ClipWithRelations = Prisma.RepurposeClipGetPayload<{ include: typeof CLIP_INCLUDE }>;

/** Long enough to watch a clip; the page refetches the list far more often. */
const MEZZANINE_URL_TTL_SECONDS = 3_600;

/**
 * How long a parsed source face track is kept, and how many. See
 * {@link RepurposeClipsService.faceTrackOf}: long enough to cover a run page
 * polling while its clips wait for a slot, few enough that a handful of
 * hour-long tracks (a few MB each, parsed) is all it ever holds.
 */
const FACE_TRACK_CACHE_MS = 5 * 60_000;
const FACE_TRACK_CACHE_SIZE = 8;

/**
 * Failure codes a run can carry once its transcript exists, so a person can
 * still add a moment of their own. `analysis_failed` and `clip_failed` are
 * written by older code only; rows carrying them still exist.
 */
const FAILED_AFTER_TRANSCRIPT: ReadonlySet<string> = new Set([
  "repurpose/highlights_failed",
  "repurpose/highlights_no_candidates",
  "repurpose/stage_timeout",
  "repurpose/analysis_failed",
  "repurpose/clip_failed",
]);

/**
 * A run's clips: cutting, retrying, listing, and the moments a person picks by
 * time (2026-09-26 clips hardening, `docs/repurpose/CLIPS-HARDENING-2026-09-26.md`
 * §4 and §5).
 *
 * What this service holds to:
 *
 *   * **A clip's failure is the clip's.** Nothing here fails a run; a run whose
 *     clips have all settled moves on to review, or back to its moments, and
 *     that is all a clip ever does to it.
 *   * **A full plan lane is not an error.** The Free plan runs two jobs at once,
 *     and a clip's own probe and proxy occupy them after it is cut. A clip asked
 *     for then is kept, `waiting`, and enqueued by the next reconcile — it used
 *     to be orphaned, spinning on "Cutting the 9:16 clip…" forever. That holds
 *     for a clip cut before, too (a retry, a re-cut): the refused request is
 *     recorded on the row ({@link markCutRequested}), since no job exists to
 *     say a cut is owed.
 *   * **Everything that can refuse, refuses before a row exists.** Run state,
 *     candidate, rate, source media: all checked before `repurpose_clips` is
 *     written, and a row this call created is removed again if the enqueue then
 *     fails for any reason other than the lane.
 *   * **It does not depend on `RepurposeService`**, so the run reconciler can
 *     depend on this without a cycle. The two things it would have borrowed —
 *     the flag check and the stage announcement — are small and restated here
 *     against the same flag names and the same projection.
 */
@Injectable()
export class RepurposeClipsService {
  private readonly logger = new Logger(RepurposeClipsService.name);
  /** When each run last reconciled from a list read. Per process, pruned as it goes. */
  private readonly reconciledAt = new Map<string, number>();
  /** Parsed source face tracks by `faces_key` ({@link faceTrackOf}). */
  private readonly faceTracks = new Map<
    string,
    { readonly at: number; readonly track: FaceTrackDocument }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementService,
    private readonly realtime: RealtimePublisher,
    private readonly audit: CommonAuditService,
    private readonly faces: FacesTrigger,
    private readonly limiter: RateLimitService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listClips(
    workspaceId: string,
    runId: string,
  ): Promise<{ readonly runId: string; readonly clips: RepurposeClipItemView[] }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);

    // The page polls this list, which makes it the natural place to notice a
    // lane that has freed: no scheduler runs in production.
    if (this.dueForReconcile(run.id)) {
      await this.reconcileClips(run.id).catch((error: unknown) => {
        this.logger.warn(
          { runId: run.id, err: error },
          "clip reconcile failed; the list is served",
        );
      });
    }

    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id },
      include: CLIP_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
    const latest = await this.latestJobs(
      run.workspaceId,
      clips.map((clip) => clip.candidateId),
    );
    const sourceGone = await this.sourceGoneFor(run, clips, latest);
    return {
      runId: run.id,
      clips: await Promise.all(
        clips.map((clip) => this.toItem(clip, latest.get(clip.candidateId), sourceGone)),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Cutting
  // -------------------------------------------------------------------------

  /**
   * Cut one moment. Idempotent per candidate: a second request for a clip that
   * is being cut, or is ready at the current profile, returns it unchanged. A
   * ready clip cut at an OLDER profile is cut again — that is how a profile
   * change (a new crop, a new size) reaches clips that already exist; the
   * editing document survives it (`RepurposeClipCompletionHandler`). So is a
   * clip whose child project's media failed its probe or proxy: cutting it again
   * is how that is repaired (CLAUDE.md §13).
   */
  async createClip(
    workspaceId: string,
    userId: string,
    runId: string,
    input: CreateClipInput,
  ): Promise<RepurposeClipItemView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    await this.assertRunHasMoments(run);

    const candidate = await this.prisma.clipCandidate.findFirst({
      where: { id: input.candidateId, runId: run.id },
    });
    if (candidate === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that moment.",
        HttpStatus.NOT_FOUND,
      );
    }

    const existingClip = await this.prisma.repurposeClip.findUnique({
      where: { candidateId: candidate.id },
      include: { variants: CLIP_CHILD_VARIANTS },
    });
    const latest =
      existingClip === null
        ? undefined
        : (await this.latestJobs(run.workspaceId, [candidate.id])).get(candidate.id);
    if (existingClip !== null && !needsCut(existingClip, latest)) {
      return this.itemFor(run, existingClip.id);
    }

    await this.consumeRunBudget(run.id);
    const media = await this.requireSourceMedia(run);

    let clip: RepurposeClip;
    let created = false;
    if (existingClip === null) {
      const existing = await this.prisma.repurposeClip.count({ where: { runId: run.id } });
      if (existing >= MAX_CLIPS_PER_RUN) {
        throw new AppException(
          REPURPOSE_CLIP_ERRORS.limitReached,
          "This video already has as many clips as one run can hold.",
          HttpStatus.CONFLICT,
          { limit: MAX_CLIPS_PER_RUN },
        );
      }
      ({ clip, created } = await this.createClipRow(run, candidate));
    } else {
      clip = existingClip;
      await this.releaseStalledCut(run, latest);
    }

    let outcome: "cutting" | "waiting";
    try {
      outcome = await this.enqueueCut(run, clip, candidate, media);
    } catch (error) {
      // Only a row this call made: a refused cut must not leave a clip that
      // looks like it is on its way.
      if (created) await this.removeUnstartedClip(run, clip);
      throw error;
    }
    if (outcome === "waiting") await this.markCutRequested(clip.id);

    await this.advanceRun(run);
    await this.audit.record({
      action: "repurpose.clip.requested",
      resource: "repurpose_clip",
      resourceId: clip.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, candidateId: candidate.id, firstCut: created },
    });
    return this.itemFor(run, clip.id);
  }

  /**
   * Cut a clip again whose last cut failed — including one whose cut landed but
   * whose child project's media failed — or that is still waiting for a slot.
   * A lane that is still full leaves it `waiting`, recorded, for the reconcile.
   */
  async retryClip(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
  ): Promise<RepurposeClipItemView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") throw this.runStopped();

    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId: run.id },
      include: { candidate: true, variants: CLIP_CHILD_VARIANTS },
    });
    if (clip === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "We could not find that clip.",
        HttpStatus.NOT_FOUND,
      );
    }

    const latest = (await this.latestJobs(run.workspaceId, [clip.candidateId])).get(
      clip.candidateId,
    );
    const { state, failureCode } = clipStateOf(clipFactsOf(clip), latest);
    if (state !== "failed" && state !== "waiting") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.clipNotRetryable,
        state === "ready" ? "This clip is already made." : "This clip is already being made.",
        HttpStatus.CONFLICT,
        { state },
      );
    }

    await this.consumeRunBudget(run.id);
    const media = await this.requireSourceMedia(run);
    await this.releaseStalledCut(run, latest);
    if ((await this.enqueueCut(run, clip, clip.candidate, media)) === "waiting") {
      await this.markCutRequested(clip.id);
    }
    await this.advanceRun(run);

    await this.audit.record({
      action: "repurpose.clip.retried",
      resource: "repurpose_clip",
      resourceId: clip.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, fromState: state, failureCode },
    });
    return this.itemFor(run, clip.id);
  }

  /**
   * Enqueue every clip of a run that is owed a cut, oldest first, and settle the
   * run if its clips are all done. Owed: `waiting` for a slot, or ready at an
   * older profile with a re-cut asked for and refused ({@link cutDue}). For the
   * run reconciler and for the clip list's own polling; never throws for a clip
   * it could not enqueue.
   *
   * Stops at the first plan-lane refusal: the rest would be refused for the
   * same reason, and they keep their place for the next pass. Idempotent — every
   * enqueue dedupes on the clip's job key.
   */
  async reconcileClips(runId: string): Promise<{ readonly enqueued: readonly string[] }> {
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    if (run === null || run.status === "cancelled") return { enqueued: [] };
    this.markReconciled(run.id);

    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id },
      include: { candidate: true, variants: CLIP_CHILD_VARIANTS },
      orderBy: { createdAt: "asc" },
    });
    const latest = await this.latestJobs(
      run.workspaceId,
      clips.map((clip) => clip.candidateId),
    );
    const owed = clips.filter((clip) => cutDue(clip, latest.get(clip.candidateId)));

    const enqueued: string[] = [];
    const media = owed.length === 0 ? undefined : await this.cuttableSource(run);
    if (media !== undefined) {
      for (const clip of owed) {
        try {
          if ((await this.enqueueCut(run, clip, clip.candidate, media)) === "waiting") break;
          enqueued.push(clip.id);
        } catch (error) {
          this.logger.warn(
            { runId: run.id, clipId: clip.id, err: error },
            "could not enqueue a waiting clip",
          );
        }
      }
    }

    await this.settleRun(run.id);
    return { enqueued };
  }

  /**
   * {@link requireSourceMedia} for a background pass, which has nobody to
   * answer. A purged original is expected, not alarming — its waiting clips
   * already read `failed` (`clipStateOf`) — so only anything else is logged.
   */
  private async cuttableSource(run: RepurposeRun): Promise<MediaAsset | undefined> {
    try {
      return await this.requireSourceMedia(run);
    } catch (error) {
      if (!(error instanceof AppException && error.code === REPURPOSE_CLIP_ERRORS.sourceExpired)) {
        this.logger.warn(
          { runId: run.id, err: error },
          "clips are waiting but the source cannot be cut from",
        );
      }
      return undefined;
    }
  }

  /** {@link settleRunAfterClips}, announced to the open run page when it moves the run. */
  async settleRun(
    runId: string,
    options: { readonly finishingJobId?: string } = {},
  ): Promise<void> {
    const settled = await settleRunAfterClips(this.prisma, runId, options);
    if (settled !== undefined) await this.publishStage(settled);
  }

  // -------------------------------------------------------------------------
  // Manual moments
  // -------------------------------------------------------------------------

  /**
   * A moment the person chose by time, for a run whose suggestions missed it,
   * found none, or failed. Idempotent on its bounds: the same start and end twice
   * is one moment (`clip_candidates` is unique on them).
   *
   * A run that failed after its transcript existed — discovery failed or timed
   * out — has moments again once one is added, so it goes back to
   * `candidates_ready` ({@link reopenWithMoments}); otherwise it would say
   * "failed" for good while the person cuts clips from it.
   */
  async addManualCandidate(
    workspaceId: string,
    userId: string,
    runId: string,
    input: AddCandidateInput,
  ): Promise<ClipCandidate> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") throw this.runStopped();
    if (run.status === "failed" && !FAILED_AFTER_TRANSCRIPT.has(run.failureCode ?? "")) {
      throw this.transcriptNotReady();
    }

    const [transcript, media] = await Promise.all([
      this.prisma.transcript.findFirst({
        where: { projectId: run.sourceProjectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
      this.prisma.mediaAsset.findFirst({
        where: { projectId: run.sourceProjectId, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: { durationMs: true },
      }),
    ]);
    if (transcript === null || media === null || media.durationMs === null) {
      throw this.transcriptNotReady();
    }

    const startMs = Math.round(input.startMs);
    const endMs = Math.round(input.endMs);
    const lengthMs = endMs - startMs;
    if (
      startMs < 0 ||
      endMs <= startMs ||
      endMs > media.durationMs ||
      lengthMs < MIN_CLIP_MS ||
      lengthMs > MAX_CLIP_MS
    ) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.boundsInvalid,
        "A moment has to be between 3 seconds and 3 minutes long, and inside the video.",
        HttpStatus.BAD_REQUEST,
        { minMs: MIN_CLIP_MS, maxMs: MAX_CLIP_MS, durationMs: media.durationMs },
      );
    }

    const existing = await this.prisma.clipCandidate.findFirst({
      where: { runId: run.id, startMs, endMs },
    });
    if (existing !== null) {
      await this.reopenWithMoments(run);
      return existing;
    }

    const manual = await this.prisma.clipCandidate.count({
      where: { runId: run.id, source: "manual" },
    });
    if (manual >= MAX_MANUAL_CANDIDATES_PER_RUN) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.limitReached,
        "This video already has as many of your own moments as one run can hold.",
        HttpStatus.CONFLICT,
        { limit: MAX_MANUAL_CANDIDATES_PER_RUN },
      );
    }

    let candidate: ClipCandidate;
    try {
      candidate = await this.prisma.clipCandidate.create({
        data: {
          id: ulid(),
          runId: run.id,
          source: "manual",
          state: "proposed",
          // Never ranked or scored: a person's own pick is not a suggestion (§10.3).
          rank: null,
          startMs,
          endMs,
          title: input.title ?? `Moment at ${timecode(startMs)}–${timecode(endMs)}`,
          transcriptExcerpt: await this.excerpt(transcript.id, startMs, endMs),
        },
      });
    } catch (error) {
      // Two requests for the same bounds at once: the other one made it.
      const raced = isUniqueViolation(error)
        ? await this.prisma.clipCandidate.findFirst({ where: { runId: run.id, startMs, endMs } })
        : null;
      if (raced === null) throw error;
      await this.reopenWithMoments(run);
      return raced;
    }

    await this.reopenWithMoments(run);
    await this.audit.record({
      action: "repurpose.candidate.added",
      resource: "clip_candidate",
      resourceId: candidate.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, startMs, endMs },
    });
    return candidate;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Build, check and enqueue one clip's `media.clip`.
   *
   * @returns `cutting` when a job is live for it (new or deduplicated), or
   *   `waiting` when the plan lane refused it — which leaves the clip exactly
   *   as it was, for the next reconcile.
   * @throws anything else: a payload that does not parse, a queue that is down.
   */
  private async enqueueCut(
    run: RepurposeRun,
    clip: RepurposeClip,
    candidate: ClipCandidate,
    media: MediaAsset,
  ): Promise<"cutting" | "waiting"> {
    // A moment is timed from transcript words, which can end a few ms past the
    // measured duration; the cut stops where the video does.
    const sourceDurationMs = media.durationMs ?? candidate.endMs;
    const endMs = Math.min(candidate.endMs, sourceDurationMs);
    if (endMs <= candidate.startMs) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.boundsInvalid,
        "This moment is outside the video.",
        HttpStatus.CONFLICT,
      );
    }

    const reframe = reframeFromTrack(await this.faceTrackOf(media), {
      fromMs: Math.max(0, candidate.startMs - CLIP_HANDLE_MS),
      toMs: Math.min(sourceDurationMs, endMs + CLIP_HANDLE_MS),
    });

    // Parsed, not assembled: the contract is the wire format the worker checks
    // too, and a payload it would refuse is better refused here, in a request.
    const payload = MediaClipPayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: run.id,
      candidateId: candidate.id,
      clipId: clip.id,
      source: { bucket: media.bucket, key: media.storageKey },
      sourceDurationMs,
      startMs: candidate.startMs,
      endMs,
      handleMs: CLIP_HANDLE_MS,
      // The key the worker is asked to write: under the SOURCE project, so the
      // artefact purges with it (CONTRACTS §6 amendment 2026-09-15).
      destination: {
        bucket: "s3",
        key: clipMasterKey({
          workspaceId: run.workspaceId,
          sourceProjectId: run.sourceProjectId,
          runId: run.id,
          candidateId: candidate.id,
        }),
      },
      profile: {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        maxHeight: CLIP_MAX_HEIGHT,
      },
      reframe,
      profileVersion: CLIP_PROFILE_VERSION,
    });

    try {
      await this.jobs.enqueue({
        type: "media.clip",
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        params: payload,
        jobKey: mediaClipJobKey(
          candidate.id,
          `${String(candidate.startMs)}-${String(endMs)}`,
          CLIP_PROFILE_VERSION,
        ),
        worstCaseTenths: 0,
        reason: `media.clip · ${clip.id}`,
      });
      return "cutting";
    } catch (error) {
      if (!isLaneFull(error)) throw error;
      this.logger.log(
        { runId: run.id, clipId: clip.id, code: (error as AppException).code },
        "plan lane is full; the clip waits for the next reconcile",
      );
      return "waiting";
    }
  }

  /**
   * The source's face track, parsed once and kept briefly. A clip waiting for a
   * lane slot is offered again on every reconcile — every few seconds while its
   * run page is open — and a long source's `faces.json` runs to megabytes, so
   * reading it for every offer, and again for every waiting clip, downloads and
   * parses it over and over only to be refused. The file never changes under
   * its key (`ai.faces` never re-detects a media that has one), so keeping it
   * cannot frame on a stale track. Only a track that parsed is kept.
   */
  private async faceTrackOf(media: MediaAsset): Promise<FaceTrackDocument | undefined> {
    const deps = {
      derived: this.derived,
      faces: this.faces,
      warn: (context: Record<string, unknown>, message: string) =>
        this.logger.warn(context, message),
    };
    const key = media.facesKey;
    if (key === null) return loadFaceTrack(deps, media);

    const now = Date.now();
    const cached = this.faceTracks.get(key);
    if (cached !== undefined && now - cached.at < FACE_TRACK_CACHE_MS) return cached.track;

    const track = await loadFaceTrack(deps, media);
    this.faceTracks.delete(key);
    if (track !== undefined) {
      this.faceTracks.set(key, { at: now, track });
      // Oldest first, in insertion order: the one kept longest goes.
      for (const oldest of this.faceTracks.keys()) {
        if (this.faceTracks.size <= FACE_TRACK_CACHE_SIZE) break;
        this.faceTracks.delete(oldest);
      }
    }
    return track;
  }

  /**
   * {@link ClipFacts.updatedAt}: the record that a cut was asked for and the
   * plan's lane refused it, so the clip reads `waiting` and the next reconcile
   * cuts it — rather than still reading `failed` (or, for a re-cut, the request
   * vanishing) because its newest job is the old one.
   */
  private async markCutRequested(clipId: string): Promise<void> {
    await this.prisma.repurposeClip.update({
      where: { id: clipId },
      data: { updatedAt: new Date() },
    });
  }

  /**
   * Cancel a clip's cut that is still open but can no longer finish
   * ({@link stalledCode}) before cutting it again: the new enqueue would
   * otherwise dedupe onto it, and it holds one of the plan's lane slots. A job
   * that finished in the meantime is simply left as it is.
   */
  private async releaseStalledCut(
    run: RepurposeRun,
    latest: LatestClipJob | undefined,
  ): Promise<void> {
    if (latest === undefined || !isLiveJob(latest) || stalledCode(latest) === null) return;
    try {
      await this.jobs.cancel(latest.id, run.workspaceId);
      this.logger.warn(
        { runId: run.id, jobId: latest.id, status: latest.status },
        "cancelled a stalled clip cut before cutting it again",
      );
    } catch (error) {
      if (!(error instanceof AppException && error.code === JOB_ERROR_CODES.invalidState)) {
        throw error;
      }
    }
  }

  /**
   * Remove the clip row this request created, after its cut was refused for a
   * reason other than the lane. Not when a concurrent request for the same
   * moment has used the row since (`createClipRow` hands it the same one): a
   * live job for it, or a touch recording a refused cut, makes the row that
   * request's as well, and deleting it would answer that request with a clip
   * that no longer exists and drop its finished cut as `clip_not_found`.
   */
  private async removeUnstartedClip(run: RepurposeRun, clip: RepurposeClip): Promise<void> {
    try {
      const latest = (await this.latestJobs(run.workspaceId, [clip.candidateId])).get(
        clip.candidateId,
      );
      if (latest !== undefined && isLiveJob(latest)) return;
      await this.prisma.repurposeClip.deleteMany({
        where: { id: clip.id, mezzanineKey: null, updatedAt: clip.updatedAt },
      });
    } catch (cleanupError) {
      this.logger.warn(
        { clipId: clip.id, err: cleanupError },
        "could not remove a clip whose cut was refused",
      );
    }
  }

  private async createClipRow(
    run: RepurposeRun,
    candidate: ClipCandidate,
  ): Promise<{ readonly clip: RepurposeClip; readonly created: boolean }> {
    try {
      const clip = await this.prisma.repurposeClip.create({
        data: {
          id: ulid(),
          runId: run.id,
          candidateId: candidate.id,
          title: candidate.title,
          sourceStartMs: candidate.startMs,
          sourceEndMs: candidate.endMs,
        },
      });
      return { clip, created: true };
    } catch (error) {
      // One clip per candidate: a concurrent request for the same moment made
      // the row first, and cutting it is exactly what this one wanted too — but
      // the row is that request's, so this one must never clean it up.
      if (!isUniqueViolation(error)) throw error;
      const clip = await this.prisma.repurposeClip.findUniqueOrThrow({
        where: { candidateId: candidate.id },
      });
      return { clip, created: false };
    }
  }

  private async latestJobs(
    workspaceId: string,
    candidateIds: readonly string[],
  ): Promise<Map<string, LatestClipJob>> {
    return latestClipJobs(this.prisma, workspaceId, candidateIds);
  }

  private async itemFor(run: RepurposeRun, clipId: string): Promise<RepurposeClipItemView> {
    const clip = await this.prisma.repurposeClip.findUniqueOrThrow({
      where: { id: clipId },
      include: CLIP_INCLUDE,
    });
    const latest = await this.latestJobs(run.workspaceId, [clip.candidateId]);
    const sourceGone = await this.sourceGoneFor(run, [clip], latest);
    return this.toItem(clip, latest.get(clip.candidateId), sourceGone);
  }

  /** Only asked when a clip is waiting — the one state a purged source changes. */
  private async sourceGoneFor(
    run: RepurposeRun,
    clips: readonly (ClipRowWithChild & { readonly candidateId: string })[],
    latest: ReadonlyMap<string, LatestClipJob>,
  ): Promise<boolean> {
    const waiting = clips.some(
      (clip) => clipStateOf(clipFactsOf(clip), latest.get(clip.candidateId)).state === "waiting",
    );
    return waiting && (await sourceRawPurged(this.prisma, run.sourceProjectId));
  }

  private async toItem(
    clip: ClipWithRelations,
    latest: LatestClipJob | undefined,
    sourceGone: boolean,
  ): Promise<RepurposeClipItemView> {
    let mezzanineUrl: string | null = null;
    if (clip.mezzanineKey !== null) {
      try {
        mezzanineUrl = await this.derived.presignGet(clip.mezzanineKey, MEZZANINE_URL_TTL_SECONDS);
      } catch (error) {
        this.logger.warn({ clipId: clip.id, err: error }, "could not sign the mezzanine URL");
      }
    }
    const { state, failureCode } = clipStateOf(clipFactsOf(clip), latest, { sourceGone });
    // JSON round trip: `sizeBytes` on the child media is a BigInt, which the
    // response serialiser cannot write.
    return JSON.parse(
      JSON.stringify({ ...clip, mezzanineUrl, state, failureCode }, (_, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ) as RepurposeClipItemView;
  }

  /**
   * The source the cut is taken from: the run's primary media, prepared, and
   * with its original still stored — `media.clip` reads the raw file, which
   * the retention sweep deletes seven days after the last job (D47).
   */
  private async requireSourceMedia(run: RepurposeRun): Promise<MediaAsset> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });
    if (media === null || media.status !== "ready" || media.storageKey === "") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "Your video is still being prepared. Try again in a moment.",
        HttpStatus.CONFLICT,
      );
    }
    if (media.rawPurgedAt !== null) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.sourceExpired,
        "The original video is no longer kept, so new clips cannot be cut from it. Start again from the same link.",
        HttpStatus.CONFLICT,
      );
    }
    return media;
  }

  private async assertRunHasMoments(run: RepurposeRun): Promise<void> {
    if (run.status === "cancelled") throw this.runStopped();
    const moments = await this.prisma.clipCandidate.count({ where: { runId: run.id } });
    if (moments === 0) {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.runNotReady,
        "There are no moments to cut yet.",
        HttpStatus.CONFLICT,
      );
    }
  }

  /**
   * A run a cut was just asked for starts showing "Creating your clips": one
   * waiting on its first clip, or one that failed after its transcript existed
   * (discovery failed or timed out, or older code failed it over a clip). The
   * person is making clips from that run regardless, so its failure is over —
   * left failed, nothing would ever move it on again, since a clip never does.
   * Conditional on the status it was read with, so a concurrent cancel wins.
   */
  private async advanceRun(run: RepurposeRun): Promise<void> {
    const reopens = isFailedAfterTranscript(run);
    if (run.status !== "candidates_ready" && !reopens) return;
    const next = {
      status: "materializing" as const,
      currentStage: "styles_formats",
      progress: 65,
      ...(reopens ? { failureCode: null, completedAt: null } : {}),
    };
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: {
        id: run.id,
        status: run.status,
        ...(reopens ? { failureCode: run.failureCode } : {}),
      },
      data: next,
    });
    if (count > 0) await this.publishStage({ ...run, ...next });
  }

  /** See {@link addManualCandidate}. Conditional, like {@link advanceRun}. */
  private async reopenWithMoments(run: RepurposeRun): Promise<void> {
    if (!isFailedAfterTranscript(run)) return;
    const next = {
      status: "candidates_ready" as const,
      currentStage: stageForStatus("candidates_ready"),
      progress: progressForStatus("candidates_ready"),
      failureCode: null,
      completedAt: null,
    };
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: { id: run.id, status: "failed", failureCode: run.failureCode },
      data: next,
    });
    if (count > 0) await this.publishStage({ ...run, ...next });
  }

  private async consumeRunBudget(runId: string): Promise<void> {
    const verdict = await this.limiter.consume(CLIP_RUN_BUCKET, runId);
    if (verdict.allowed) return;
    throw new AppException(
      ERROR_CODES.rateLimited,
      "Too many clips were asked for at once. Try again in a moment.",
      HttpStatus.TOO_MANY_REQUESTS,
      { bucket: CLIP_RUN_BUCKET.name, retryAfterSec: verdict.retryAfterSec },
    );
  }

  /** Up to 2,000 characters of what is said in `[startMs, endMs]`, for the moment's card. */
  private async excerpt(transcriptId: string, startMs: number, endMs: number): Promise<string> {
    const chunks = await newestChunkRows(this.prisma, transcriptId);
    return chunks
      .flatMap((chunk) => (chunk.words as unknown as Word[] | null) ?? [])
      .filter((word) => word.deleted !== true && word.s >= startMs && word.e <= endMs)
      .map((word) => word.t)
      .join(" ")
      .slice(0, 2_000);
  }

  /**
   * The same pace as a run read's reconcile (`RECONCILE_INTERVAL_MS`): the page
   * polls this list every few seconds, the plan lane does not free that often,
   * and each attempt is an admission query.
   */
  private dueForReconcile(runId: string, now = Date.now()): boolean {
    const last = this.reconciledAt.get(runId);
    return last === undefined || now - last >= RECONCILE_INTERVAL_MS;
  }

  private markReconciled(runId: string, now = Date.now()): void {
    this.reconciledAt.set(runId, now);
    // Only recent entries matter, and a long-lived process sees many runs.
    if (this.reconciledAt.size > 1_000) {
      for (const [id, at] of this.reconciledAt) {
        if (now - at >= RECONCILE_INTERVAL_MS) this.reconciledAt.delete(id);
      }
    }
  }

  /**
   * The same rule as `RepurposeService.flagEnabled`: an explicit value in
   * `FEATURE_FLAGS_JSON` wins, otherwise the workspace's entitlement decides.
   * Answers 404, not 403, while the surface is off.
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

  /** The announcement `RepurposeService.publishStage` makes, from the same projection. */
  private async publishStage(run: RepurposeRun): Promise<void> {
    const projection = projectRun(run);
    await this.realtime.publish(workspaceRoom(run.workspaceId), "repurpose.stage.changed", {
      runId: run.id,
      status: run.status,
      stage: projection.currentStage,
      progress: projection.progress,
      message: projection.message,
      at: new Date().toISOString(),
    });
  }

  private runStopped(): AppException {
    return new AppException(
      REPURPOSE_CLIP_ERRORS.runNotReady,
      "This run was stopped, so nothing new can be made from it.",
      HttpStatus.CONFLICT,
    );
  }

  private transcriptNotReady(): AppException {
    return new AppException(
      REPURPOSE_CLIP_ERRORS.runNotReady,
      "You can add your own moments once the transcript is ready.",
      HttpStatus.CONFLICT,
    );
  }
}

function isFailedAfterTranscript(run: RepurposeRun): boolean {
  return run.status === "failed" && FAILED_AFTER_TRANSCRIPT.has(run.failureCode ?? "");
}

/**
 * Whether a request for an existing clip should cut it. Not while it is being
 * cut, and not when it is ready at the current profile — a double click must
 * not cut twice. Anything else is cut: waiting, failed (which includes a cut
 * whose child media failed, or whose job stalled), or ready at an older profile.
 */
function needsCut(clip: ClipRowWithChild, latest: LatestClipJob | undefined): boolean {
  const facts = clipFactsOf(clip);
  const { state } = clipStateOf(facts, latest);
  if (state === "cutting") return false;
  if (state !== "ready") return true;
  return facts.profileVersion !== null && facts.profileVersion !== CLIP_PROFILE_VERSION;
}

/**
 * Whether a reconcile pass should enqueue a clip on its own: it is `waiting`, or
 * it is ready at an older profile and a re-cut of it was asked for and refused
 * a slot. Never a `failed` clip — that is the person's to retry — and never a
 * ready clip nobody asked to re-cut: a profile bump alone does not re-cut every
 * clip of every run that happens to be opened.
 */
function cutDue(clip: ClipRowWithChild, latest: LatestClipJob | undefined): boolean {
  const facts = clipFactsOf(clip);
  const { state } = clipStateOf(facts, latest);
  if (state === "waiting") return true;
  return (
    state === "ready" &&
    latest !== undefined &&
    cutRequestedSince(facts, latest) &&
    facts.profileVersion !== null &&
    facts.profileVersion !== CLIP_PROFILE_VERSION
  );
}

/** The plan's lane or its enqueued-credit cap: both clear as jobs finish. */
function isLaneFull(error: unknown): boolean {
  return (
    error instanceof AppException &&
    (error.code === JOB_ERROR_CODES.concurrencyCap || error.code === JOB_ERROR_CODES.enqueueCap)
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002"
  );
}

/** `83_000` → `1:23`; `3_723_000` → `1:02:03`. */
export function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${String(minutes)}:${seconds}`;
}
