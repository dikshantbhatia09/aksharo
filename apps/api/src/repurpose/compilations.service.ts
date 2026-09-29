import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ulid } from "ulid";

import { quote, type Env } from "@montaj/config";
import {
  COMPILATION_LIMITS,
  REPURPOSE_SCHEMA_VERSION,
  RenderCompilationPayloadSchema,
  compilationJobKey,
  compilationSize,
} from "@montaj/repurpose-contracts";

import {
  captionedVideoOf,
  clipIdsOf,
  compilationFailureOf,
  compilationFingerprint,
  introOf,
  plannedDurationMs,
  sourcesChanged,
  storedSourcesOf,
  titleOf,
  type ClipWithShapes,
  type ShapeVideo,
} from "./compilation-plan.js";
import {
  COMPILATION_ERRORS,
  type CompilationShape,
  type CreateCompilationInput,
} from "./compilations.dto.js";
import {
  ASPECT_OF_SHAPE,
  CAPTIONED_URL_TTL_SECONDS,
  RECONCILE_INTERVAL_MS,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  SHAPE_OF_ASPECT,
} from "./repurpose.constants.js";
import { BrandKitService } from "../brand-kit/brand-kit.service.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { JOB_ERROR_CODES } from "../jobs/jobs.errors.js";
import { JobsService } from "../jobs/jobs.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { RepurposeCompilation, RepurposeRun } from "@prisma/client";

/**
 * A compilation as `GET .../compilations` returns it (2026-10-03).
 *
 * `status` is the row's, except `expired`: made, but its file is gone -
 * export retention deletes a render seven days after it is made, as for every
 * export. `stale`: a clip's captioned video changed since it was made (its
 * captions were edited, a series label went on); "Make again" joins the
 * current ones. `progress` is the render's own percent while it is made.
 */
export interface CompilationView {
  readonly id: string;
  readonly runId: string;
  readonly shape: CompilationShape;
  readonly title: string | null;
  readonly clipIds: readonly string[];
  readonly status: "waiting" | "rendering" | "ready" | "failed" | "expired";
  readonly failureCode: string | null;
  readonly durationMs: number | null;
  readonly progress: number | null;
  readonly playUrl: string | null;
  readonly downloadUrl: string | null;
  /** When the file is deleted (seven days after it is made); null when it is kept. */
  readonly expiresAt: string | null;
  readonly stale: boolean;
  readonly canRetry: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The clip rows a compilation reads, with each shape's newest captioned video. */
const CLIP_SHAPES_SELECT = {
  id: true,
  candidate: { select: { state: true } },
  variants: {
    select: {
      aspect: true,
      status: true,
      latestExport: {
        select: { id: true, status: true, storageKey: true, durationMs: true, watermarked: true },
      },
    },
  },
} as const;

/** How many waiting compilations one sweep offers the lane, across every run. */
const SWEEP_BATCH = 50;

/**
 * A run's clips joined into one video (2026-10-03): the "best of" a person
 * picks on the run page, in one shape, with a short fade between clips and an
 * optional title card in the brand kit's colours.
 *
 * What it holds to:
 *
 *   * **Only what the page plays is joined.** Each clip's captioned video of
 *     the shape (Autopilot's, `captionClips`), never a clean cut or a video
 *     being remade: a clip without one refuses the request, naming the clips.
 *   * **One compilation per request.** The same clips in the same order, shape
 *     and title are the same compilation (`fingerprint`), answered as it is.
 *   * **The file is an export.** Of the run's source project, written by
 *     `render.compilation` and finished by its completion handler, so export
 *     retention and downloads apply unchanged; making it again replaces it.
 *   * **A full plan lane is a wait, not a refusal.** The compilation is kept
 *     `waiting` and the reconcile (every read of the run's clips, and the
 *     watchdog) asks again, like a clip. A refusal that will not clear (no
 *     credits) refuses the request, and leaves no row behind.
 *   * **It costs the cloud render rate** on the joined video's minutes: held
 *     on the planned length, settled on the measured one.
 */
@Injectable()
export class RepurposeCompilationsService {
  private readonly logger = new Logger(RepurposeCompilationsService.name);
  /** When each run's compilations were last reconciled from a read. Per process. */
  private readonly reconciledAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    @Inject(ENV) private readonly env: Env,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    /** The title card's colours, typeface and logo; absent in harnesses (the product's own). */
    @Optional() private readonly brandKits?: BrandKitService,
  ) {}

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  async list(
    workspaceId: string,
    runId: string,
  ): Promise<{ readonly runId: string; readonly compilations: CompilationView[] }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (this.dueForReconcile(run.id)) {
      await this.reconcileRun(run.id).catch((error: unknown) => {
        this.logger.warn({ runId: run.id, err: error }, "compilation reconcile failed; listed");
      });
    }
    const rows = await this.prisma.repurposeCompilation.findMany({
      where: { runId: run.id },
      orderBy: { createdAt: "desc" },
    });
    return { runId: run.id, compilations: await this.viewsOf(run, rows) };
  }

  async get(workspaceId: string, runId: string, compilationId: string): Promise<CompilationView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const row = await this.requireCompilation(run, compilationId);
    const [view] = await this.viewsOf(run, [row]);
    if (view === undefined) throw this.notFound();
    return view;
  }

  /**
   * Make a compilation, or answer with the one these clips, shape and title
   * already made. `created` says which, for the route's status code.
   */
  async create(
    workspaceId: string,
    userId: string,
    runId: string,
    input: CreateCompilationInput,
  ): Promise<{ readonly compilation: CompilationView; readonly created: boolean }> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const title = titleOf(input.title);
    const fingerprint = compilationFingerprint({
      clipIds: input.clipIds,
      shape: input.shape,
      title,
    });

    const existing = await this.prisma.repurposeCompilation.findUnique({
      where: { runId_fingerprint: { runId: run.id, fingerprint } },
    });
    if (existing !== null) {
      return { compilation: await this.viewOf(run, existing), created: false };
    }

    // Everything that can refuse, refuses before a row exists.
    const videos = await this.videosFor(run, input.clipIds, input.shape);
    this.assertWithinCap(videos, title);

    let row: RepurposeCompilation;
    try {
      row = await this.prisma.repurposeCompilation.create({
        data: {
          id: ulid(),
          runId: run.id,
          workspaceId: run.workspaceId,
           
          aspect: ASPECT_OF_SHAPE[input.shape],
          title,
          clipIds: [...input.clipIds],
          fingerprint,
          status: "waiting",
          durationMs: plannedDurationMs(videos, title),
          createdBy: userId,
        },
      });
    } catch (error) {
      // The same compilation asked for twice at once: the other request made it.
      const raced = isUniqueViolation(error)
        ? await this.prisma.repurposeCompilation.findUnique({
            where: { runId_fingerprint: { runId: run.id, fingerprint } },
          })
        : null;
      if (raced === null) throw error;
      return { compilation: await this.viewOf(run, raced), created: false };
    }

    try {
      await this.start(run, row, videos);
    } catch (error) {
      // Refused (no credits, a queue that is down): nothing is left behind.
      await this.prisma.repurposeCompilation
        .deleteMany({ where: { id: row.id, exportId: null } })
        .catch(() => undefined);
      throw error;
    }

    await this.audit.record({
      action: "repurpose.compilation.requested",
      resource: "repurpose_compilation",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: {
        runId: run.id,
        clips: input.clipIds.length,
        shape: input.shape,
        title: title !== null,
      },
    });
    return { compilation: await this.viewOf(run, await this.fresh(row.id)), created: true };
  }

  /**
   * Make it again: a failed one, one whose file has expired, or one whose clips
   * have changed since. The clips' current captioned videos are joined, and the
   * earlier file (if any) is deleted - the new one replaces it.
   */
  async retry(
    workspaceId: string,
    userId: string,
    runId: string,
    compilationId: string,
  ): Promise<CompilationView> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const row = await this.requireCompilation(run, compilationId);
    const [before] = await this.viewsOf(run, [row]);
    if (before === undefined || !before.canRetry) {
      throw new AppException(
        COMPILATION_ERRORS.notRetryable,
        before?.status === "ready"
          ? "This compilation is already made from these clips."
          : "This compilation is already being made.",
        HttpStatus.CONFLICT,
        { status: before?.status ?? row.status },
      );
    }

    const shape = SHAPE_OF_ASPECT[row.aspect];
    const videos = await this.videosFor(run, clipIdsOf(row.clipIds), shape);
    this.assertWithinCap(videos, row.title);

    await this.dropExport(row.exportId);
    await this.prisma.repurposeCompilation.update({
      where: { id: row.id },
      data: { status: "waiting", failureCode: null, exportId: null, jobId: null },
    });
    try {
      await this.start(run, await this.fresh(row.id), videos);
    } catch (error) {
      await this.fail(row.id, null, error);
      throw error;
    }

    await this.audit.record({
      action: "repurpose.compilation.retried",
      resource: "repurpose_compilation",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, fromStatus: before.status, stale: before.stale },
    });
    return this.viewOf(run, await this.fresh(row.id));
  }

  /** Delete it: its render stops if it is being made, and its file goes. */
  async remove(
    workspaceId: string,
    userId: string,
    runId: string,
    compilationId: string,
  ): Promise<void> {
    await this.assertAvailable(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const row = await this.requireCompilation(run, compilationId);
    if (row.jobId !== null && row.status === "rendering") {
      await this.jobs.cancel(row.jobId, run.workspaceId).catch((error: unknown) => {
        // Finished a moment ago: nothing left to stop.
        if (!(error instanceof AppException && error.code === JOB_ERROR_CODES.invalidState)) {
          throw error;
        }
      });
    }
    await this.prisma.repurposeCompilation.deleteMany({ where: { id: row.id } });
    await this.dropExport(row.exportId);
    await this.audit.record({
      action: "repurpose.compilation.deleted",
      resource: "repurpose_compilation",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, status: row.status },
    });
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * Move a run's compilations on: a waiting one is offered the lane again, and
   * one whose render ended without its completion reaching this row is settled
   * from its job. Called from every reconcile of the run's clips and from the
   * list; never throws for one compilation.
   */
  async reconcileRun(runId: string): Promise<void> {
    this.markReconciled(runId);
    const rows = await this.prisma.repurposeCompilation.findMany({
      where: { runId, status: { in: ["waiting", "rendering"] } },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length === 0) return;
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    if (run === null) return;

    for (const row of rows) {
      try {
        if (row.status === "rendering") {
          await this.settleLost(row);
          continue;
        }
        const shape = SHAPE_OF_ASPECT[row.aspect];
        let videos: ShapeVideo[];
        try {
          videos = await this.videosFor(run, clipIdsOf(row.clipIds), shape);
        } catch (error) {
          // A clip being made again after an edit comes back; one that is gone does not.
          if (await this.clipsGone(run, clipIdsOf(row.clipIds))) {
            await this.fail(row.id, null, error, COMPILATION_ERRORS.sourceGone);
          }
          continue;
        }
        // Every compilation of a run shares the workspace's lane: the rest wait too.
        if ((await this.start(run, row, videos)) === "waiting") break;
      } catch (error) {
        await this.fail(row.id, null, error);
      }
    }
  }

  /**
   * The watchdog's pass (`RepurposeReconciler`): every run with a compilation
   * waiting for the lane, whatever state the run itself is in - a run long
   * finished still has clips to join. Never throws.
   */
  async sweep(): Promise<void> {
    try {
      const waiting = await this.prisma.repurposeCompilation.findMany({
        where: { status: { in: ["waiting", "rendering"] } },
        select: { runId: true },
        orderBy: { createdAt: "asc" },
        take: SWEEP_BATCH,
      });
      for (const runId of new Set(waiting.map((row) => row.runId))) {
        await this.reconcileRun(runId).catch((error: unknown) => {
          this.logger.warn({ runId, err: error }, "could not reconcile a run's compilations");
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, "compilation sweep failed; the next one retries");
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Ask for the compilation's render. The export row (the file's) is written
   * and the compilation pointed at it first, so no completion can land before
   * the row it finishes; a full lane undoes both and leaves it `waiting`.
   * Anything else is thrown, with the attempt undone the same way.
   */
  private async start(
    run: RepurposeRun,
    compilation: RepurposeCompilation,
    videos: readonly ShapeVideo[],
  ): Promise<"rendering" | "waiting"> {
    const shape = SHAPE_OF_ASPECT[compilation.aspect];
    const size = compilationSize(shape);
    const kit =
      compilation.title === null || this.brandKits === undefined
        ? null
        : await this.brandKits.forClips(run.workspaceId).catch((error: unknown) => {
            this.logger.warn(
              { runId: run.id, err: error },
              "could not read the brand kit; the title card uses the product's colours",
            );
            return null;
          });
    const exportId = ulid();
    const payload = RenderCompilationPayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: run.id,
      compilationId: compilation.id,
      exportId,
      projectId: run.sourceProjectId,
      shape,
      ...size,
      fps: COMPILATION_LIMITS.fps,
      fadeMs: COMPILATION_LIMITS.fadeMs,
      clips: videos.map((video) => ({
        clipId: video.clipId,
        key: video.key,
        durationMs: video.durationMs,
      })),
      ...(compilation.title === null ? {} : { intro: introOf(compilation.title, kit) }),
    });
    const plannedMs = plannedDurationMs(videos, compilation.title);

    await this.prisma.export.create({
      data: {
        id: exportId,
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        status: "rendering",
        kind: "mp4",
        preset: `compilation-${shape.replace(":", "x")}`,
        bucket: "r2",
        // What its clips carry: a compilation adds no mark and removes none.
        watermarked: videos.some((video) => video.watermarked),
        resolution: `${String(size.width)}x${String(size.height)}`,
      },
    });
    await this.prisma.repurposeCompilation.update({
      where: { id: compilation.id },
      data: {
        status: "rendering",
        exportId,
        jobId: null,
        failureCode: null,
        durationMs: plannedMs,
        sources: videos.map((video) => ({
          clipId: video.clipId,
          exportId: video.exportId,
          durationMs: video.durationMs,
        })),
      },
    });

    try {
      const { job } = await this.jobs.enqueue({
        type: "render.compilation",
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        params: payload,
        jobKey: compilationJobKey(compilation.id, exportId),
        // The cloud render rate on the joined minutes; settled on the measured length.
        worstCaseTenths: quote("cloudRender", plannedMs / 60_000).holdTenths,
        reason: `render.compilation · ${compilation.id}`,
      });
      await this.prisma.repurposeCompilation.updateMany({
        where: { id: compilation.id, exportId },
        data: { jobId: job.id, attempts: { increment: 1 } },
      });
      await this.prisma.export.updateMany({ where: { id: exportId }, data: { jobId: job.id } });
      this.logger.log(
        { runId: run.id, compilationId: compilation.id, jobId: job.id, clips: videos.length },
        "asked for a compilation",
      );
      return "rendering";
    } catch (error) {
      await this.prisma.repurposeCompilation.updateMany({
        where: { id: compilation.id, exportId },
        data: { status: "waiting", exportId: null },
      });
      await this.prisma.export.deleteMany({ where: { id: exportId, storageKey: null } });
      if (isLaneFull(error)) {
        this.logger.log(
          { runId: run.id, compilationId: compilation.id },
          "plan lane is full; the compilation waits for the next reconcile",
        );
        return "waiting";
      }
      throw error;
    }
  }

  /**
   * Each clip's captioned video in `shape`, in the order given - or a refusal
   * naming every clip that has none (not this run's, removed, or its video in
   * that shape not made yet).
   */
  private async videosFor(
    run: RepurposeRun,
    clipIds: readonly string[],
    shape: CompilationShape,
  ): Promise<ShapeVideo[]> {
    const clips: ClipWithShapes[] = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id, id: { in: [...clipIds] } },
      select: CLIP_SHAPES_SELECT,
    });
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    const videos: ShapeVideo[] = [];
    const notReady: string[] = [];
    for (const clipId of clipIds) {
      const clip = byId.get(clipId);
      const video = clip === undefined ? null : captionedVideoOf(clip, shape);
      if (video === null) notReady.push(clipId);
      else videos.push(video);
    }
    if (notReady.length > 0 || videos.length < COMPILATION_LIMITS.minClips) {
      throw new AppException(
        COMPILATION_ERRORS.clipsNotReady,
        notReady.length === 1
          ? `One clip has no captioned ${shape} video yet.`
          : `${String(notReady.length)} clips have no captioned ${shape} video yet.`,
        HttpStatus.CONFLICT,
        { clipIds: notReady, shape },
      );
    }
    return videos;
  }

  /** Whether any of the clips is not this run's any more, or its moment was removed. */
  private async clipsGone(run: RepurposeRun, clipIds: readonly string[]): Promise<boolean> {
    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id, id: { in: [...clipIds] } },
      select: { id: true, candidate: { select: { state: true } } },
    });
    return (
      clips.length < new Set(clipIds).size ||
      clips.some((clip) => clip.candidate.state === "rejected")
    );
  }

  private assertWithinCap(videos: readonly ShapeVideo[], title: string | null): void {
    const durationMs = plannedDurationMs(videos, title);
    if (durationMs <= COMPILATION_LIMITS.maxOutputMs) return;
    throw new AppException(
      COMPILATION_ERRORS.tooLong,
      `A compilation can be up to ${String(COMPILATION_LIMITS.maxOutputMs / 60_000)} minutes long.`,
      HttpStatus.BAD_REQUEST,
      { durationMs, maxDurationMs: COMPILATION_LIMITS.maxOutputMs },
    );
  }

  /**
   * A compilation still `rendering` whose job has ended without its completion
   * reaching the row (a lost callback, a job settled by the lease reaper before
   * its handler ran): read from the job and its export.
   */
  private async settleLost(row: RepurposeCompilation): Promise<void> {
    if (row.jobId === null || row.exportId === null) return;
    const job = await this.prisma.job.findUnique({
      where: { id: row.jobId },
      select: { status: true, error: true },
    });
    if (job === null || job.status === "queued" || job.status === "running") return;
    if (job.status === "succeeded") {
      const made = await this.prisma.export.findUnique({
        where: { id: row.exportId },
        select: { status: true, storageKey: true, durationMs: true },
      });
      if (made?.status === "succeeded" && made.storageKey !== null) {
        await this.prisma.repurposeCompilation.updateMany({
          where: { id: row.id, exportId: row.exportId, status: "rendering" },
          data: {
            status: "ready",
            ...(made.durationMs === null ? {} : { durationMs: made.durationMs }),
          },
        });
        return;
      }
    }
    const code = (job.error as { readonly code?: unknown } | null)?.code;
    await this.fail(
      row.id,
      row.exportId,
      null,
      compilationFailureOf(typeof code === "string" ? code : null),
    );
  }

  /** Marks one attempt failed, with the code the page has words for. Never throws. */
  private async fail(
    compilationId: string,
    exportId: string | null,
    error: unknown,
    code?: string,
  ): Promise<void> {
    const failureCode =
      code ?? compilationFailureOf(error instanceof AppException ? error.code : null);
    this.logger.warn({ compilationId, failureCode, err: error }, "a compilation could not be made");
    await this.prisma.repurposeCompilation
      .updateMany({
        where: { id: compilationId, ...(exportId === null ? {} : { exportId }) },
        data: { status: "failed", failureCode },
      })
      .catch(() => undefined);
    if (exportId !== null) {
      await this.prisma.export
        .updateMany({ where: { id: exportId, status: "rendering" }, data: { status: "failed" } })
        .catch(() => undefined);
    }
  }

  /** The object first, then the row: an interrupted delete leaves a row to retry, never an orphan. */
  private async dropExport(exportId: string | null): Promise<void> {
    if (exportId === null) return;
    const row = await this.prisma.export.findUnique({
      where: { id: exportId },
      select: { storageKey: true },
    });
    if (row === null) return;
    if (row.storageKey !== null) await this.derived.delete(row.storageKey);
    await this.prisma.export.deleteMany({ where: { id: exportId } });
  }

  private async viewOf(run: RepurposeRun, row: RepurposeCompilation): Promise<CompilationView> {
    const [view] = await this.viewsOf(run, [row]);
    if (view === undefined) throw this.notFound();
    return view;
  }

  private async viewsOf(
    run: RepurposeRun,
    rows: readonly RepurposeCompilation[],
  ): Promise<CompilationView[]> {
    if (rows.length === 0) return [];
    const exportIds = rows.flatMap((row) => (row.exportId === null ? [] : [row.exportId]));
    const jobIds = rows.flatMap((row) => (row.jobId === null ? [] : [row.jobId]));
    const [exports, jobs, clips] = await Promise.all([
      exportIds.length === 0
        ? []
        : this.prisma.export.findMany({
            where: { id: { in: exportIds } },
            select: { id: true, status: true, storageKey: true, expiresAt: true },
          }),
      jobIds.length === 0
        ? []
        : this.prisma.job.findMany({
            where: { id: { in: jobIds } },
            select: { id: true, status: true, progress: true },
          }),
      this.prisma.repurposeClip.findMany({ where: { runId: run.id }, select: CLIP_SHAPES_SELECT }),
    ]);
    const exportById = new Map(exports.map((row) => [row.id, row]));
    const jobById = new Map(jobs.map((row) => [row.id, row]));
    // Each shape's current captioned videos, worked out once per shape listed.
    const currentByShape = new Map<CompilationShape, Map<string, ShapeVideo | null>>();
    const currentIn = (shape: CompilationShape): Map<string, ShapeVideo | null> => {
      let current = currentByShape.get(shape);
      if (current === undefined) {
        current = new Map(clips.map((clip) => [clip.id, captionedVideoOf(clip, shape)]));
        currentByShape.set(shape, current);
      }
      return current;
    };

    const views: CompilationView[] = [];
    for (const row of rows) {
      const shape = SHAPE_OF_ASPECT[row.aspect];
      const made = row.exportId === null ? undefined : exportById.get(row.exportId);
      const current = currentIn(shape);
      const expired = row.status === "ready" && (made === undefined || made.storageKey === null);
      const status: CompilationView["status"] = expired ? "expired" : row.status;
      const stale = row.status === "ready" && sourcesChanged(storedSourcesOf(row.sources), current);
      const job = row.jobId === null ? undefined : jobById.get(row.jobId);

      let playUrl: string | null = null;
      let downloadUrl: string | null = null;
      if (status === "ready" && made !== undefined && made.storageKey !== null) {
        const name = `${(row.title ?? "Compilation").slice(0, 70)} ${shape.replace(":", "x")}.mp4`;
        try {
          [playUrl, downloadUrl] = await Promise.all([
            this.derived.presignGet(made.storageKey, CAPTIONED_URL_TTL_SECONDS),
            this.derived.presignGet(made.storageKey, CAPTIONED_URL_TTL_SECONDS, {
              downloadFilename: name,
            }),
          ]);
        } catch (error) {
          this.logger.warn({ compilationId: row.id, err: error }, "could not sign a compilation");
        }
      }

      views.push({
        id: row.id,
        runId: row.runId,
        shape,
        title: row.title,
        clipIds: clipIdsOf(row.clipIds),
        status,
        failureCode: status === "failed" ? row.failureCode : null,
        durationMs: row.durationMs,
        progress: status === "rendering" && job?.status === "running" ? job.progress : null,
        playUrl,
        downloadUrl,
        expiresAt: status === "ready" ? (made?.expiresAt?.toISOString() ?? null) : null,
        stale,
        canRetry: status === "failed" || status === "expired" || stale,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return views;
  }

  private async fresh(id: string): Promise<RepurposeCompilation> {
    return this.prisma.repurposeCompilation.findUniqueOrThrow({ where: { id } });
  }

  private async requireCompilation(
    run: RepurposeRun,
    compilationId: string,
  ): Promise<RepurposeCompilation> {
    const row = await this.prisma.repurposeCompilation.findFirst({
      where: { id: compilationId, runId: run.id },
    });
    if (row === null) throw this.notFound();
    return row;
  }

  private notFound(): AppException {
    return new AppException(
      COMPILATION_ERRORS.notFound,
      "We could not find that compilation.",
      HttpStatus.NOT_FOUND,
    );
  }

  /** The same pace as a clip list read's reconcile: a lane does not free every poll. */
  private dueForReconcile(runId: string, now = Date.now()): boolean {
    const last = this.reconciledAt.get(runId);
    return last === undefined || now - last >= RECONCILE_INTERVAL_MS;
  }

  private markReconciled(runId: string, now = Date.now()): void {
    this.reconciledAt.set(runId, now);
    if (this.reconciledAt.size > 1_000) {
      for (const [id, at] of this.reconciledAt) {
        if (now - at >= RECONCILE_INTERVAL_MS) this.reconciledAt.delete(id);
      }
    }
  }

  /**
   * The same rule as the clips' (`RepurposeClipsService`): an explicit value in
   * `FEATURE_FLAGS_JSON` wins, else the workspace's entitlement; 404 while off.
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

  /** Workspace and id together, never "find by id, then check". */
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
