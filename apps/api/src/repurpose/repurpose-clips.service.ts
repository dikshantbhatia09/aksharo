import { statfs } from "node:fs/promises";

import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";
import type { Word } from "@montaj/edg/schemas";
import type { FaceTrackDocument } from "@montaj/render-core";
import {
  IMAGE_FILES,
  MediaClipPayloadSchema,
  MediaStillsPayloadSchema,
  REPURPOSE_SCHEMA_VERSION,
  VIDEO_SHAPES,
  VIDEO_SHAPE_SIZE,
  clipMasterKey,
  mediaClipJobKey,
} from "@montaj/repurpose-contracts";

import {
  IMAGE_ATTEMPTS,
  IMAGE_URL_TTL_SECONDS,
  type ImagePlan,
  type ShapeVideos,
  clipFolder,
  fileOfImage,
  planClipImages,
  stillsJobKey,
  stillsKeyPrefix,
  storedImagesOf,
} from "./clip-images.js";
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
import { STAGE_OF_FAILURE } from "./failure-codes.js";
import { awaitingFaceDetection, loadFaceTrack, reframeFromTrack } from "./reframe.js";
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
  ASPECT_OF_SHAPE,
  AUTOPILOT_CLIP_ATTEMPTS,
  AUTOPILOT_CLIP_RETRY_CODES,
  FORMAT_CUT_ATTEMPTS,
  FORMAT_SHAPES,
  FORMATS_MIN_FREE_BYTES,
  SHAPE_OF_ASPECT,
  formatCutKeyPrefix,
  type FormatShape,
  CAPTIONED_QUIET_MS,
  CAPTIONED_RENDER_ATTEMPTS,
  CAPTIONED_URL_TTL_SECONDS,
  CLIP_PROFILE_VERSION,
  RECONCILE_INTERVAL_MS,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  automationOf,
  autopilotClipCount,
} from "./repurpose.constants.js";
import { progressForStatus, projectRun, stageForStatus } from "./repurpose.projection.js";
import { autopilotPicks, cutBoundsOf, isRemoved } from "./steering.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, ERROR_CODES, PrismaService, RateLimitService } from "../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { newestChunkRows } from "../edg/chunk-rows.js";
import { ExportsService } from "../exports/exports.service.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { JobsService } from "../jobs/jobs.service.js";
import { FacesTrigger, facesJobKey } from "../media/faces.js";
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
/**
 * A ready clip's captioned video (Autopilot runs, 2026-09-28): `rendering`
 * while it is being made, `stale` when the captions were edited and it will be
 * made again shortly, `failed` when it could not be made. `playUrl` and
 * `downloadUrl` point at the newest finished file (null until there is one).
 */
export interface CaptionedClipView {
  readonly status: "rendering" | "ready" | "stale" | "failed";
  readonly playUrl: string | null;
  readonly downloadUrl: string | null;
}

/**
 * One shape of a ready clip (2026-09-29). `preparing` while it is cut, probed
 * and captioned; then the captioned video's own states. `cleanUrl` downloads
 * the same shape without captions.
 */
export interface ClipFormatView {
  readonly shape: (typeof VIDEO_SHAPES)[number];
  readonly status: "preparing" | CaptionedClipView["status"];
  readonly projectId: string | null;
  readonly captioned: CaptionedClipView | null;
  readonly cleanUrl: string | null;
}

/**
 * A clip's image formats (2026-09-29): `preparing` until its videos have
 * settled and the images are taken, `ready` with every image file, `failed`
 * when they could not be made. `files` holds what is made, even while a newer
 * set is being prepared.
 */
export interface ClipImagesView {
  readonly status: "none" | "preparing" | "ready" | "failed";
  readonly files: readonly {
    readonly id: string;
    readonly width: number;
    readonly height: number;
    readonly items: readonly { readonly url: string; readonly downloadUrl: string }[];
  }[];
}

export interface RepurposeClipItemView {
  readonly id: string;
  readonly candidateId: string;
  readonly state: ClipState;
  readonly failureCode: string | null;
  readonly mezzanineUrl: string | null;
  /** The captioned video, for an Autopilot run's ready clip; null otherwise. */
  readonly captioned: CaptionedClipView | null;
  /** Every shape of the clip, once it is ready ({@link ClipFormatView}). */
  readonly formats: readonly ClipFormatView[];
  /** The clip's images, on an Autopilot run's ready clip ({@link ClipImagesView}). */
  readonly images: ClipImagesView;
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
 * hour-long tracks (a few MB each, parsed) is all it ever holds. No one track
 * is larger than `FACE_TRACK_MAX_BYTES` (`reframe.ts`), which is read — and so
 * kept — by nobody.
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
 *   * **A clip waits for its source's face track**, the same way and for a
 *     few minutes at most: one cut before detection lands is framed on the
 *     centre for good (`reframe.ts`, {@link awaitingFaceDetection}).
 *   * **Everything that can refuse, refuses before a row exists.** Run state,
 *     candidate, rate, source media: all checked before `repurpose_clips` is
 *     written, and a row this call created is removed again if the enqueue then
 *     fails for any reason other than the lane.
 *   * **It does not depend on `RepurposeService`**, so the run reconciler can
 *     depend on this without a cycle. The two things it would have borrowed —
 *     the flag check and the stage announcement — are small and restated here
 *     against the same flag names and the same projection.
 */
/**
 * The cloud export each shape is rendered with: the preset of that canvas, or
 * 1920 x 1080 for 16:9 (the only 16:9 preset is 4K).
 */
const RENDER_SIZE_OF_ASPECT = {
  r9x16: { preset: "reels" },
  r4x5: { preset: "instagram-feed" },
  r1x1: { preset: "square" },
  r16x9: { preset: "custom", customWidth: 1920, customHeight: 1080 },
} as const;

/**
 * Where Autopilot asks for clips: the run has its moments and is cutting or
 * showing them. Not before (no moments yet), and not once it failed or was
 * stopped (a failed run is retried as a run, by the reconciler).
 */
const AUTOPILOT_STATUSES: ReadonlySet<string> = new Set([
  "candidates_ready",
  "materializing",
  "review_ready",
]);

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
    /** Makes the captioned videos of Autopilot clips; absent in hand-built harnesses. */
    @Optional() private readonly exports?: ExportsService,
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

    // A removed moment's clip is kept, so "Restore" brings it back as it was,
    // but it is not listed (steering, 2026-09-29).
    const clips = (
      await this.prisma.repurposeClip.findMany({
        where: { runId: run.id },
        include: CLIP_INCLUDE,
        orderBy: { createdAt: "asc" },
      })
    ).filter((clip) => !isRemoved(clip.candidate));
    const latest = await this.latestJobs(
      run.workspaceId,
      clips.map((clip) => clip.candidateId),
    );
    const sourceGone = await this.sourceGoneFor(run, clips, latest);
    return {
      runId: run.id,
      clips: await Promise.all(
        clips.map((clip) =>
          this.toItem(clip, latest.get(clip.candidateId), sourceGone, automationOf(run) === "auto"),
        ),
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

    // The source is checked before the budget is spent: a refusal costs nothing.
    const media = await this.sourceForCut(run);
    await this.consumeRunBudget(run.id);

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
      // A source still being prepared (moments can be ready before its video
      // encode is, W5): the clip waits, and the reconcile cuts it once the
      // media is ready and its face track has been asked for.
      outcome =
        media === "preparing" ? "waiting" : await this.enqueueCut(run, clip, candidate, media);
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
   * whose child project's media failed — or that is still waiting (for a slot,
   * or for its source's face track). A lane that is still full, or a track still
   * being made, leaves it `waiting`, recorded, for the reconcile.
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

    const media = await this.sourceForCut(run);
    await this.consumeRunBudget(run.id);
    await this.releaseStalledCut(run, latest);
    if (
      media === "preparing" ||
      (await this.enqueueCut(run, clip, clip.candidate, media)) === "waiting"
    ) {
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
   * Stops at the first clip told to wait — a full plan lane, or a source whose
   * face track is still being made: every clip of a run shares both, so the
   * rest would wait for the same reason, and they keep their place for the next
   * pass. Idempotent — every enqueue dedupes on the clip's job key.
   */
  async reconcileClips(runId: string): Promise<{ readonly enqueued: readonly string[] }> {
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    if (run === null || run.status === "cancelled") return { enqueued: [] };
    this.markReconciled(run.id);
    // Autopilot asks for the cuts; the loop below makes them, like any other.
    if (automationOf(run) === "auto") await this.autopilot(run);

    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id },
      include: { candidate: true, variants: CLIP_CHILD_VARIANTS },
      orderBy: { createdAt: "asc" },
    });
    const latest = await this.latestJobs(
      run.workspaceId,
      clips.map((clip) => clip.candidateId),
    );
    // Never a removed moment's clip: removing it cancelled its cut.
    const owed = clips.filter(
      (clip) => !isRemoved(clip.candidate) && cutDue(clip, latest.get(clip.candidateId)),
    );

    const enqueued: string[] = [];
    const media = owed.length === 0 ? undefined : await this.cuttableSource(run);
    if (media === "failed") {
      await this.failRunOnDeadSource(run, clips);
      return { enqueued };
    }
    if (media !== undefined && media !== "preparing") {
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
   * Autopilot (`automationOf`, 2026-09-28): the cuts a person would have asked
   * for, asked for by the run itself.
   *
   * The best moments the run has get a clip row - as many as it asked
   * discovery for before its reserve, and every one the person added; never
   * one they removed (`autopilotPicks`) - and a clip whose last cut failed for
   * a passing reason
   * ({@link AUTOPILOT_CLIP_RETRY_CODES}) is asked for again, up to
   * {@link AUTOPILOT_CLIP_ATTEMPTS} cuts per moment. Rows and touches only: a
   * new row, or a failed clip touched after its cut ended, reads `waiting`
   * (`clipStateOf`), and {@link reconcileClips}' owed-clip loop cuts it through
   * the plan's lane exactly as it cuts one a person asked for. Idempotent: a
   * moment with a clip is never given a second one (one clip per candidate).
   *
   * Never throws: it runs inside the reconcile every read and the watchdog
   * make, and the next pass tries again.
   */
  private async autopilot(run: RepurposeRun): Promise<void> {
    if (!AUTOPILOT_STATUSES.has(run.status)) return;
    try {
      const [candidates, clips, source] = await Promise.all([
        this.prisma.clipCandidate.findMany({
          where: { runId: run.id, state: { not: "rejected" } },
          orderBy: [{ rank: "asc" }, { startMs: "asc" }],
        }),
        this.prisma.repurposeClip.findMany({
          where: { runId: run.id },
          include: { candidate: true, variants: CLIP_CHILD_VARIANTS },
        }),
        this.prisma.mediaAsset.findFirst({
          where: { projectId: run.sourceProjectId, role: "primary" },
          orderBy: { createdAt: "desc" },
          select: { durationMs: true },
        }),
      ]);

      // Steering (2026-09-29): the best `autopilotClipCount` suggestions are
      // cut, and every moment the person added; the rest of what discovery
      // found waits in reserve, and the best of it takes the place of a clip
      // the person removes (`autopilotPicks`).
      const picks = autopilotPicks({
        candidates,
        withClip: new Set(clips.map((clip) => clip.candidateId)),
        target: autopilotClipCount(source?.durationMs),
        room: MAX_CLIPS_PER_RUN - clips.length,
      });
      let cut = 0;
      for (const candidate of picks) {
        const { created } = await this.createClipRow(run, candidate);
        if (created) cut += 1;
      }

      let retried = 0;
      const latest = await this.latestJobs(
        run.workspaceId,
        clips.map((clip) => clip.candidateId),
      );
      for (const clip of clips) {
        if (isRemoved(clip.candidate)) continue;
        const job = latest.get(clip.candidateId);
        const { state, failureCode } = clipStateOf(clipFactsOf(clip), job);
        if (state !== "failed" || failureCode === null) continue;
        if (!AUTOPILOT_CLIP_RETRY_CODES.has(failureCode)) continue;
        if ((await this.endedCuts(run.workspaceId, clip.candidateId)) >= AUTOPILOT_CLIP_ATTEMPTS) {
          continue;
        }
        await this.releaseStalledCut(run, job);
        await this.markCutRequested(clip.id);
        retried += 1;
      }

      if (cut > 0) await this.advanceRun(run);
      await this.captionClips(run);
      await this.cutFormats(run);
      await this.makeImages(run);
      if (cut + retried > 0) {
        this.logger.log({ runId: run.id, cut, retried }, "autopilot asked for clips");
        await this.audit.record({
          action: "repurpose.autopilot.clips",
          resource: "repurpose_run",
          resourceId: run.id,
          actorKind: "system",
          workspaceId: run.workspaceId,
          data: { cut, retried },
        });
      }
    } catch (error) {
      this.logger.warn(
        { runId: run.id, err: error },
        "autopilot could not ask for clips this pass",
      );
    }
  }

  /**
   * Autopilot's captioned videos (owner decision, 2026-09-28): every clip that
   * is cut gets a real MP4 with its captions burned in, made by the ordinary
   * cloud export of the clip's own project (its caption style, kept off faces),
   * so the run page shows and downloads the finished video.
   *
   * Per clip, its 9:16 variant records the export (`latestExportId`) and the
   * editing document's revision it was made from (`editFingerprint`):
   *
   *   * nothing made yet: made once the clip's media is ready, its captions
   *     document exists and its face track is settled;
   *   * made from an older revision (the captions were edited): made again
   *     {@link CAPTIONED_QUIET_MS} after the last edit;
   *   * the render failed: made again, up to {@link CAPTIONED_RENDER_ATTEMPTS}
   *     failed renders per clip;
   *   * refused outright (no credits, say): left until the captions change.
   *
   * A full plan lane is "not now"; the next pass asks again. Never throws.
   */
  private async captionClips(run: RepurposeRun, now: number = Date.now()): Promise<void> {
    const exports = this.exports;
    if (exports === undefined) return;
    const variants = await this.prisma.clipVariant.findMany({
      where: {
        clip: {
          runId: run.id,
          mezzanineKey: { not: null },
          // A removed moment's clip is not rendered (steering, 2026-09-29).
          candidate: { state: { not: "rejected" } },
        },
      },
      include: {
        latestExport: { select: { id: true, status: true } },
        project: {
          select: {
            edgDocument: { select: { revision: true, updatedAt: true } },
            mediaAssets: {
              where: { role: "primary" },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, status: true, facesKey: true, durationMs: true },
            },
          },
        },
      },
    });

    for (const variant of variants) {
      try {
        const doc = variant.project.edgDocument;
        const media = variant.project.mediaAssets[0];
        if (doc === null || media === undefined || media.status !== "ready") continue;
        const fingerprint = `edg:${String(doc.revision)}`;
        const latest = variant.latestExport;
        const current = variant.editFingerprint === fingerprint;

        if (
          latest !== null &&
          (latest.status === "rendering" || latest.status === "pending_browser")
        ) {
          if (variant.status !== "rendering") await this.setVariant(variant.id, "rendering");
          continue;
        }
        if (latest !== null && latest.status === "succeeded" && current) {
          if (variant.status !== "ready") {
            await this.setVariant(variant.id, "ready");
            await this.dropSupersededRenders(variant.projectId, latest.id);
          }
          continue;
        }
        if (latest !== null && latest.status === "failed" && current) {
          const failed = await this.prisma.export.count({
            where: { projectId: variant.projectId, status: "failed" },
          });
          if (failed >= CAPTIONED_RENDER_ATTEMPTS) {
            if (variant.status !== "failed") await this.setVariant(variant.id, "failed");
            continue;
          }
        }
        if (latest === null && variant.status === "failed" && current) continue; // refused
        // Captions edited since the last file: wait for the edits to settle.
        if (latest !== null && !current && now - doc.updatedAt.getTime() < CAPTIONED_QUIET_MS) {
          if (variant.status !== "stale") await this.setVariant(variant.id, "stale");
          continue;
        }
        // Captions keep off faces in the render: wait for the face track.
        if (
          media.facesKey === null &&
          (await this.faceDetectionPending(media.id, media.durationMs))
        ) {
          continue;
        }

        // Reels and Shorts first: another shape's video waits for disk.
        if (variant.aspect !== "r9x16" && !(await this.roomForFormats(run))) continue;
        const requested = await exports.requestExport({
          projectId: variant.projectId,
          workspaceId: run.workspaceId,
          userId: run.createdBy,
          kind: "video",
          outputKind: "video",
          ...RENDER_SIZE_OF_ASPECT[variant.aspect],
          script: "roman",
          mode: "cloud",
          dropFillers: false,
          options: { watermarkPosition: "bottom-right", watermarkOpacity: 1 },
        });
        await this.prisma.clipVariant.update({
          where: { id: variant.id },
          data: {
            latestExportId: requested.exportId,
            status: "rendering",
            editFingerprint: fingerprint,
          },
        });
        this.logger.log(
          {
            runId: run.id,
            projectId: variant.projectId,
            exportId: requested.exportId,
            fingerprint,
          },
          "autopilot asked for a captioned video",
        );
      } catch (error) {
        if (isLaneFull(error)) return; // every clip shares the lane: the next pass asks again
        this.logger.warn(
          { runId: run.id, projectId: variant.projectId, err: error },
          "could not ask for a captioned video; left until the captions change",
        );
        const doc = variant.project.edgDocument;
        await this.prisma.clipVariant
          .update({
            where: { id: variant.id },
            data: {
              status: "failed",
              ...(doc === null ? {} : { editFingerprint: `edg:${String(doc.revision)}` }),
            },
          })
          .catch(() => undefined);
      }
    }
  }

  /**
   * Free space on the volume the stores sit on. Below
   * {@link FORMATS_MIN_FREE_BYTES} Autopilot stops making a clip's other
   * shapes and images (2026-09-29) until there is room again; the 9:16 clip and
   * its captioned video are never held here (worker-media holds any cut the
   * disk cannot take). A field so a test can set it.
   */
  freeBytes: () => Promise<number> = async () => {
    try {
      const facts = await statfs(process.cwd());
      return Number(facts.bavail) * Number(facts.bsize);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  private lowDiskLoggedAt = 0;

  private async roomForFormats(run: RepurposeRun): Promise<boolean> {
    const free = await this.freeBytes();
    if (free >= FORMATS_MIN_FREE_BYTES) return true;
    if (Date.now() - this.lowDiskLoggedAt > 10 * 60_000) {
      this.lowDiskLoggedAt = Date.now();
      this.logger.warn(
        { runId: run.id, freeBytes: free, needBytes: FORMATS_MIN_FREE_BYTES },
        "low disk: holding the other formats and images until there is room",
      );
    }
    return false;
  }

  /**
   * Old renders of one clip shape (2026-09-29): once a newer captioned video
   * is made, the files of the earlier ones are deleted. Edits re-make it, and
   * with four shapes a clip would otherwise keep every version it ever had.
   * The export rows stay (their history); only the objects go.
   */
  private async dropSupersededRenders(projectId: string, keepExportId: string): Promise<void> {
    try {
      const old = await this.prisma.export.findMany({
        where: {
          projectId,
          id: { not: keepExportId },
          status: "succeeded",
          storageKey: { not: null },
        },
        select: { id: true, storageKey: true },
      });
      for (const row of old) {
        if (row.storageKey === null) continue;
        await this.derived.delete(row.storageKey);
        await this.prisma.export.update({ where: { id: row.id }, data: { storageKey: null } });
      }
      if (old.length > 0) {
        this.logger.log({ projectId, dropped: old.length }, "deleted superseded clip renders");
      }
    } catch (error) {
      this.logger.warn({ projectId, err: error }, "could not delete superseded clip renders");
    }
  }

  /** The shapes of a clip, as its images see them ({@link planClipImages}). */
  private shapeVideosOf(clip: ClipWithRelations): ShapeVideos[] {
    return clip.variants.map((variant) => {
      const made =
        variant.latestExportId === null
          ? undefined
          : variant.project.exports.find(
              (row) =>
                row.id === variant.latestExportId &&
                row.status === "succeeded" &&
                row.storageKey !== null,
            );
      const clean = variant.project.mediaAssets
        .filter((media) => media.role === "primary" && media.storageKey !== "")
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      return {
        shape: SHAPE_OF_ASPECT[variant.aspect],
        // Made, or failed for good. A variant is created `ready` by its cut,
        // before its captioned video is even asked for, so `ready` alone is
        // not "made": the first image sets were taken from 9:16 alone.
        settled:
          variant.status === "failed" ||
          (variant.status === "ready" && made !== undefined && made.storageKey !== null),
        captioned:
          variant.status === "ready" && made !== undefined && made.storageKey !== null
            ? { exportId: made.id, key: made.storageKey }
            : null,
        clean:
          clean === undefined || clean.status !== "ready"
            ? null
            : { mediaId: clean.id, key: clean.storageKey },
      };
    });
  }

  /** Shapes of an Autopilot clip whose cut was given up. */
  private async abandonedShapes(
    workspaceId: string | undefined,
    clip: ClipWithRelations,
  ): Promise<Set<(typeof VIDEO_SHAPES)[number]>> {
    const had = new Set(clip.variants.map((variant) => SHAPE_OF_ASPECT[variant.aspect]));
    const abandoned = new Set<(typeof VIDEO_SHAPES)[number]>();
    for (const shape of FORMAT_SHAPES) {
      if (had.has(shape)) continue;
      // The key names the candidate (a ULID), so the workspace only narrows it.
      const ended = await this.prisma.job.count({
        where: {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          type: "media.clip",
          jobKey: { startsWith: formatCutKeyPrefix(clip.candidateId, shape) },
          status: { in: ["failed", "cancelled"] },
        },
      });
      if (ended >= FORMAT_CUT_ATTEMPTS) abandoned.add(shape);
    }
    return abandoned;
  }

  private async imagePlanOf(
    workspaceId: string | undefined,
    clip: ClipWithRelations,
  ): Promise<ImagePlan> {
    if (clip.mezzanineKey === null) return { kind: "none" };
    return planClipImages({
      videos: this.shapeVideosOf(clip),
      abandoned: await this.abandonedShapes(workspaceId, clip),
      folder: clipFolder(clip.mezzanineKey),
      durationMs: clip.mezzanineDurationMs ?? clip.sourceEndMs - clip.sourceStartMs,
    });
  }

  /**
   * Autopilot's images (2026-09-29): once every shape of a clip has settled,
   * one `media.stills` job takes its posts, carousel slides, pin, thumbnail,
   * covers and banners from its videos ({@link planClipImages}). New captions
   * make a new set; a set that failed {@link IMAGE_ATTEMPTS} times is left.
   */
  private async makeImages(run: RepurposeRun): Promise<void> {
    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id, mezzanineKey: { not: null } },
      include: CLIP_INCLUDE,
    });
    let roomChecked = false;
    for (const clip of clips) {
      if (clip.mezzanineKey === null || isRemoved(clip.candidate)) continue;
      try {
        const plan = await this.imagePlanOf(run.workspaceId, clip);
        if (plan.kind !== "ready") continue;
        if (storedImagesOf(clip.images)?.fingerprint === plan.fingerprint) continue;
        const jobKey = stillsJobKey(clip.id, plan.fingerprint);
        const jobs = await this.prisma.job.findMany({
          where: {
            workspaceId: run.workspaceId,
            type: "media.stills",
            jobKey: { startsWith: stillsKeyPrefix(clip.id) },
          },
          select: { status: true, jobKey: true },
        });
        // One set at a time per clip: an older set still being taken would
        // otherwise land after this one and file itself over it.
        if (jobs.some((job) => job.status === "queued" || job.status === "running")) continue;
        const ofThisSet = jobs.filter((job) => job.jobKey === jobKey);
        // Succeeded: its completion is landing (or has, and the set is stored).
        if (ofThisSet.some((job) => job.status === "succeeded")) continue;
        if (ofThisSet.length >= IMAGE_ATTEMPTS) continue;
        if (!roomChecked) {
          if (!(await this.roomForFormats(run))) return;
          roomChecked = true;
        }

        // A clean frame (covers, banners) is cropped down at the speaker's face.
        let focusY: number | undefined;
        if (plan.cleanFrom !== null) {
          const variant = clip.variants.find(
            (row) => SHAPE_OF_ASPECT[row.aspect] === plan.cleanFrom,
          );
          const media = variant?.project.mediaAssets.find((row) => row.role === "primary");
          if (media !== undefined && media.facesKey !== null) {
            const reframe = reframeFromTrack(await this.faceTrackOf(media), {
              fromMs: 0,
              toMs: media.durationMs ?? clip.sourceEndMs - clip.sourceStartMs,
            });
            if (reframe.basis === "faces" && reframe.centerY !== undefined) {
              focusY = reframe.centerY;
            }
          }
        }
        const images = plan.images.map((image) => {
          const file = fileOfImage(image.name);
          // eslint-disable-next-line security/detect-object-injection -- key is a closed enum (image file id / video shape), not input
          return focusY !== undefined && file !== null && !IMAGE_FILES[file].captioned
            ? { ...image, focusY }
            : image;
        });
        const payload = MediaStillsPayloadSchema.parse({
          schemaVersion: REPURPOSE_SCHEMA_VERSION,
          runId: run.id,
          clipId: clip.id,
          destination: { bucket: "s3", key: `${clipFolder(clip.mezzanineKey)}/images` },
          images,
          fingerprint: plan.fingerprint,
        });
        await this.jobs.enqueue({
          type: "media.stills",
          workspaceId: run.workspaceId,
          projectId: run.sourceProjectId,
          params: payload,
          jobKey,
          worstCaseTenths: 0,
          reason: `media.stills · ${clip.id}`,
        });
        this.logger.log(
          { runId: run.id, clipId: clip.id, images: images.length },
          "autopilot asked for a clip's images",
        );
      } catch (error) {
        if (isLaneFull(error)) return;
        this.logger.warn(
          { runId: run.id, clipId: clip.id, err: error },
          "could not ask for a clip's images; the next pass tries again",
        );
      }
    }
  }

  /** The images of a ready Autopilot clip, signed ({@link ClipImagesView}). */
  private async imagesOf(clip: ClipWithRelations): Promise<ClipImagesView> {
    const stored = storedImagesOf(clip.images);
    const plan = await this.imagePlanOf(undefined, clip);
    let status: ClipImagesView["status"];
    if (plan.kind === "none") status = stored === null ? "none" : "ready";
    else if (plan.kind === "waiting") status = "preparing";
    else if (stored?.fingerprint === plan.fingerprint) status = "ready";
    else {
      const failed = await this.prisma.job.count({
        where: {
          type: "media.stills",
          jobKey: stillsJobKey(clip.id, plan.fingerprint),
          status: { in: ["failed", "cancelled"] },
        },
      });
      if (failed < IMAGE_ATTEMPTS) status = "preparing";
      else status = stored === null ? "failed" : "ready";
    }

    const files = new Map<
      string,
      { id: string; width: number; height: number; items: { url: string; downloadUrl: string }[] }
    >();
    const title = clip.title.slice(0, 60) || "clip";
    for (const image of stored?.images ?? []) {
      const id = fileOfImage(image.name);
      if (id === null) continue;
      try {
        const [url, downloadUrl] = await Promise.all([
          this.derived.presignGet(image.key, IMAGE_URL_TTL_SECONDS),
          this.derived.presignGet(image.key, IMAGE_URL_TTL_SECONDS, {
            downloadFilename: `${title} ${image.name}.jpg`,
          }),
        ]);
        const file = files.get(id) ?? { id, width: image.width, height: image.height, items: [] };
        file.items.push({ url, downloadUrl });
        files.set(id, file);
      } catch (error) {
        this.logger.warn({ clipId: clip.id, err: error }, "could not sign a clip image");
      }
    }
    return { status, files: [...files.values()] };
  }

  /**
   * Autopilot's other formats (owner decision, 2026-09-29): every clip is cut
   * again in 4:5, 1:1 and 16:9, each on its own frame centred on the speaker
   * (`reframeFromTrack`, with the face's height for a source taller than the
   * shape), and each becomes its own variant and project through the same
   * completion as the 9:16 cut - its own face track, its captions placed off
   * faces, its own captioned video ({@link captionClips}).
   *
   * Only once every 9:16 clip of the run is made, so Reels and Shorts are
   * ready first. A format that failed is cut again up to
   * {@link FORMAT_CUT_ATTEMPTS} times; a full lane stops the pass.
   */
  private async cutFormats(run: RepurposeRun): Promise<void> {
    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id },
      include: { candidate: true, variants: CLIP_CHILD_VARIANTS },
    });
    if (clips.length === 0) return;
    const latest = await this.latestJobs(
      run.workspaceId,
      clips.map((clip) => clip.candidateId),
    );
    const states = clips.map((clip) =>
      clipStateOf(clipFactsOf(clip), latest.get(clip.candidateId)),
    );
    if (states.some(({ state }) => state === "waiting" || state === "cutting")) return;

    const ready = clips.filter((clip, index) => states.at(index)?.state === "ready");
    if (ready.length === 0) return;
    if (!(await this.roomForFormats(run))) return;
    const shapesHad = await this.prisma.clipVariant.findMany({
      where: { clipId: { in: ready.map((clip) => clip.id) } },
      select: { clipId: true, aspect: true },
    });
    const had = new Set(shapesHad.map((row) => `${row.clipId}:${row.aspect}`));

    let media: MediaAsset | "preparing" | "failed" | undefined;
    for (const clip of ready) {
      if (isRemoved(clip.candidate)) continue;
      for (const shape of FORMAT_SHAPES) {
        // eslint-disable-next-line security/detect-object-injection -- key is a closed enum (image file id / video shape), not input
        if (had.has(`${clip.id}:${ASPECT_OF_SHAPE[shape]}`)) continue;
        media ??= await this.cuttableSource(run);
        if (media === undefined || media === "preparing" || media === "failed") return;
        // The cuts of these bounds only: a moment whose times were changed has
        // its old shapes' cuts behind it, and a succeeded one of those must
        // not read as "its completion is landing" (steering, `cutBoundsOf`).
        const prefix = `${formatCutKeyPrefix(clip.candidateId, shape)}${cutBoundsOf(clip.candidate, media.durationMs)}:`;
        const jobs = await this.prisma.job.findMany({
          where: {
            workspaceId: run.workspaceId,
            type: "media.clip",
            jobKey: { startsWith: prefix },
          },
          select: { status: true },
        });
        if (jobs.some((job) => job.status === "queued" || job.status === "running")) continue;
        if (jobs.some((job) => job.status === "succeeded")) continue; // its completion is landing
        if (
          jobs.filter((job) => job.status === "failed" || job.status === "cancelled").length >=
          FORMAT_CUT_ATTEMPTS
        ) {
          continue;
        }
        try {
          await this.enqueueFormatCut(run, clip, clip.candidate, media, shape);
        } catch (error) {
          if (isLaneFull(error)) return;
          this.logger.warn(
            { runId: run.id, clipId: clip.id, shape, err: error },
            "could not cut a clip's other format; the next pass tries again",
          );
        }
      }
    }
  }

  /** One format cut of `clip` ({@link cutFormats}); throws what the enqueue throws. */
  private async enqueueFormatCut(
    run: RepurposeRun,
    clip: RepurposeClip,
    candidate: ClipCandidate,
    media: MediaAsset,
    shape: FormatShape,
  ): Promise<void> {
    const sourceDurationMs = media.durationMs ?? candidate.endMs;
    const endMs = Math.min(candidate.endMs, sourceDurationMs);
    if (endMs <= candidate.startMs) return;
    const track = await this.faceTrackOf(media);
    const reframe = reframeFromTrack(track, {
      fromMs: Math.max(0, candidate.startMs - CLIP_HANDLE_MS),
      toMs: Math.min(sourceDurationMs, endMs + CLIP_HANDLE_MS),
    });
    const master = clipMasterKey({
      workspaceId: run.workspaceId,
      sourceProjectId: run.sourceProjectId,
      runId: run.id,
      candidateId: candidate.id,
    });
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
      destination: {
        bucket: "s3",
        key: master.replace(/master\.mp4$/, `master-${shape.replace(":", "x")}.mp4`),
      },
      profile: {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        // eslint-disable-next-line security/detect-object-injection -- key is a closed enum (image file id / video shape), not input
        maxHeight: VIDEO_SHAPE_SIZE[shape].height,
      },
      reframe,
      aspect: shape,
      profileVersion: CLIP_PROFILE_VERSION,
    });
    await this.jobs.enqueue({
      type: "media.clip",
      workspaceId: run.workspaceId,
      projectId: run.sourceProjectId,
      params: payload,
      jobKey: `${formatCutKeyPrefix(candidate.id, shape)}${cutBoundsOf(candidate, media.durationMs)}:${CLIP_PROFILE_VERSION}`,
      worstCaseTenths: 0,
      reason: `media.clip ${shape} · ${clip.id}`,
    });
    this.logger.log(
      { runId: run.id, clipId: clip.id, shape },
      "autopilot asked for a clip's other format",
    );
  }

  private async setVariant(
    id: string,
    status: "rendering" | "ready" | "stale" | "failed",
  ): Promise<void> {
    await this.prisma.clipVariant.update({ where: { id }, data: { status } });
  }

  /** How many cuts of this moment have ended without a clip (failed or cancelled). */
  private async endedCuts(workspaceId: string, candidateId: string): Promise<number> {
    return this.prisma.job.count({
      where: {
        workspaceId,
        type: "media.clip",
        jobKey: { startsWith: `media.clip:${candidateId}:` },
        status: { in: ["failed", "cancelled"] },
      },
    });
  }

  /**
   * {@link sourceForCut} for a background pass, which has nobody to answer.
   * A source still being prepared is expected (the pass runs every few seconds
   * through a long encode), and so is a purged original — its waiting clips
   * already read `failed` (`clipStateOf`) — so only anything else is logged.
   * `"failed"`: the source failed its preparation, and no clip will ever be cut.
   */
  private async cuttableSource(
    run: RepurposeRun,
  ): Promise<MediaAsset | "preparing" | "failed" | undefined> {
    try {
      return await this.sourceForCut(run);
    } catch (error) {
      if (error instanceof AppException && error.code === REPURPOSE_CLIP_ERRORS.sourceFailed) {
        return "failed";
      }
      if (!(error instanceof AppException && error.code === REPURPOSE_CLIP_ERRORS.sourceExpired)) {
        this.logger.warn(
          { runId: run.id, err: error },
          "clips are waiting but the source cannot be cut from",
        );
      }
      return undefined;
    }
  }

  /**
   * A run with moments whose source then failed its preparation (its proxy
   * failed after an early transcription found the moments, W5) and that has
   * no clip to show: nothing will ever be cut, so it fails as a video that
   * could not be prepared, rather than leave its clips waiting for good. The
   * run's "Try again" fetches a link again; an upload has to be uploaded
   * again. A run with a clip already made keeps it.
   */
  private async failRunOnDeadSource(
    run: RepurposeRun,
    clips: readonly RepurposeClip[],
  ): Promise<void> {
    if (clips.some((clip) => clip.mezzanineKey !== null)) return;
    if (run.status !== "candidates_ready" && run.status !== "materializing") return;
    const next = {
      status: "failed" as const,
      failureCode: "repurpose/processing_failed",
      currentStage: STAGE_OF_FAILURE.processing,
      completedAt: new Date(),
    };
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: { id: run.id, status: run.status },
      data: next,
    });
    if (count > 0) {
      this.logger.warn({ runId: run.id }, "the run's source failed after its moments; run failed");
      await this.publishStage({ ...run, ...next });
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
   *   `waiting` when it is not cut yet — the plan lane refused it, or the
   *   source's face track is still being made ({@link awaitingFaceDetection}) —
   *   which leaves the clip exactly as it was, for the next reconcile.
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

    const track = await this.faceTrackOf(media);
    // A source with no track has had detection queued by now (by the read
    // above, or an earlier one). Cut now, the clip would be framed on the centre
    // for good — nothing re-frames a clip that is ready at the current profile —
    // which on deploy was every clip of every source proxied before `ai.faces`.
    // So it waits, like a clip the lane refused, and the next reconcile cuts it
    // with the track; bounded, so detection that fails or stalls costs the
    // framing, never the clip.
    if (
      track === undefined &&
      media.facesKey === null &&
      (await this.faceDetectionPending(media.id, media.durationMs))
    ) {
      this.logger.log(
        { runId: run.id, clipId: clip.id, mediaId: media.id },
        "the source's face track is still being made; the clip waits for the next reconcile",
      );
      return "waiting";
    }
    const reframe = reframeFromTrack(track, {
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
   * {@link awaitingFaceDetection} for the source's newest `ai.faces` job —
   * including one {@link faceTrackOf} queued a moment ago. The source's
   * duration sets how long detection is given to run. A lookup that fails does
   * not hold the cut: framing never costs a clip.
   */
  private async faceDetectionPending(
    mediaId: string,
    sourceDurationMs: number | null,
  ): Promise<boolean> {
    try {
      const job = await this.prisma.job.findFirst({
        where: { type: "ai.faces", jobKey: facesJobKey(mediaId) },
        orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
        select: { status: true, queuedAt: true, startedAt: true, finishedAt: true },
      });
      return awaitingFaceDetection(job, sourceDurationMs);
    } catch (error) {
      this.logger.warn(
        { mediaId, err: error },
        "could not look up the source's face detection; clip cut on centre",
      );
      return false;
    }
  }

  /**
   * {@link ClipFacts.updatedAt}: the record that a cut was asked for and could
   * not start — the plan's lane refused it, or it waits for the source's face
   * track — so the clip reads `waiting` and the next reconcile cuts it, rather
   * than still reading `failed` (or, for a re-cut, the request vanishing)
   * because its newest job is the old one.
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
    return this.toItem(
      clip,
      latest.get(clip.candidateId),
      sourceGone,
      automationOf(run) === "auto",
    );
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
    autopilot = false,
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
    const captioned = state === "ready" ? await this.captionedOf(clip) : null;
    const formats = state === "ready" ? await this.formatsOf(clip, autopilot) : [];
    const images: ClipImagesView =
      state === "ready" && autopilot ? await this.imagesOf(clip) : { status: "none", files: [] };
    // JSON round trip: `sizeBytes` on the child media is a BigInt, which the
    // response serialiser cannot write.
    return JSON.parse(
      JSON.stringify(
        { ...clip, mezzanineUrl, state, failureCode, captioned, formats, images },
        (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      ),
    ) as RepurposeClipItemView;
  }

  /**
   * The captioned video of a ready clip ({@link captionClips}), for the card:
   * where it stands, and the newest finished file to play and to download
   * (kept while a newer one is being made). Null when none was ever asked for
   * - a run not on Autopilot, or a clip whose captions are still being prepared.
   */
  private async captionedOf(clip: ClipWithRelations): Promise<CaptionedClipView | null> {
    const variant = clip.variants.find((row) => row.aspect === "r9x16");
    return variant === undefined ? null : this.captionedOfVariant(clip, variant);
  }

  /**
   * Every shape of a ready clip (2026-09-29): 9:16 and, on Autopilot, 4:5, 1:1
   * and 16:9 - each with its captioned video once made, and its clean cut.
   * A shape still being cut or prepared reads `preparing`.
   */
  private async formatsOf(clip: ClipWithRelations, autopilot: boolean): Promise<ClipFormatView[]> {
    const formats: ClipFormatView[] = [];
    for (const shape of VIDEO_SHAPES) {
      const variant = clip.variants.find((row) => SHAPE_OF_ASPECT[row.aspect] === shape);
      if (variant === undefined) {
        if (autopilot)
          formats.push({
            shape,
            status: "preparing",
            projectId: null,
            captioned: null,
            cleanUrl: null,
          });
        continue;
      }
      const captioned = await this.captionedOfVariant(clip, variant);
      const clean = variant.project.mediaAssets.find((media) => media.role === "primary");
      let cleanUrl: string | null = null;
      if (clean !== undefined && clean.storageKey !== "") {
        cleanUrl = await this.derived
          .presignGet(clean.storageKey, CAPTIONED_URL_TTL_SECONDS, {
            downloadFilename: `${clip.title.slice(0, 70) || "clip"} ${shape.replace(":", "x")} no captions.mp4`,
          })
          .catch(() => null);
      }
      formats.push({
        shape,
        status: captioned?.status ?? (autopilot ? "preparing" : "ready"),
        projectId: variant.projectId,
        captioned,
        cleanUrl,
      });
    }
    return formats;
  }

  private async captionedOfVariant(
    clip: ClipWithRelations,
    variant: ClipWithRelations["variants"][number],
  ): Promise<CaptionedClipView | null> {
    if (variant.latestExportId === null && variant.status !== "failed") return null;
    const shape = SHAPE_OF_ASPECT[variant.aspect];
    const exports = variant.project.exports;
    const done = exports.find((row) => row.status === "succeeded" && row.storageKey !== null);
    const status: CaptionedClipView["status"] =
      variant.status === "ready" ||
      variant.status === "stale" ||
      variant.status === "failed" ||
      variant.status === "rendering"
        ? variant.status
        : "rendering";
    if (done === undefined || done.storageKey === null)
      return { status, playUrl: null, downloadUrl: null };
    try {
      const [playUrl, downloadUrl] = await Promise.all([
        this.derived.presignGet(done.storageKey, CAPTIONED_URL_TTL_SECONDS),
        this.derived.presignGet(done.storageKey, CAPTIONED_URL_TTL_SECONDS, {
          downloadFilename: `${clip.title.slice(0, 70) || "clip"} ${shape.replace(":", "x")}.mp4`,
        }),
      ]);
      return { status, playUrl, downloadUrl };
    } catch (error) {
      this.logger.warn({ clipId: clip.id, err: error }, "could not sign the captioned video");
      return { status, playUrl: null, downloadUrl: null };
    }
  }

  /**
   * The source the cut is taken from: the run's primary media, prepared, and
   * with its original still stored — `media.clip` reads the raw file, which
   * the retention sweep deletes seven days after the last job (D47).
   */
  private async sourceForCut(run: RepurposeRun): Promise<MediaAsset | "preparing"> {
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });
    if (media?.status === "failed") {
      throw new AppException(
        REPURPOSE_CLIP_ERRORS.sourceFailed,
        "This video could not be prepared, so no clips can be cut from it.",
        HttpStatus.CONFLICT,
      );
    }
    // Stored and still being probed or encoded: moments can be ready before
    // the video is (W5), and a clip asked for then waits, not refused.
    if (
      media !== null &&
      media.storageKey !== "" &&
      media.rawPurgedAt === null &&
      (media.status === "uploaded" || media.status === "probing")
    ) {
      return "preparing";
    }
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
