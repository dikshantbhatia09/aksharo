import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";

import {
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
} from "./repurpose.constants.js";
import { isCancellable, isRetryable, projectRun, stageForStatus } from "./repurpose.projection.js";
import { SOURCE_REJECTION_MESSAGES, parseSourceUrl } from "./source-url.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { ENV } from "../config/config.module.js";
import { MediaService } from "../media/media.service.js";
import { ProjectsService } from "../projects/projects.service.js";
import { workspaceRoom } from "../realtime/realtime.protocol.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";
import { StylesService } from "../styles/styles.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { CreateRunInput, CreateRunResponse, ListRunsInput, RunPage, RunView } from "./repurpose.dto.js";
import type { $Enums, RepurposeRun } from "@prisma/client";

/**
 * REP-006: create, list, read, cancel and retry a repurposing run.
 *
 * What this service is careful about:
 *
 *   * **Every lookup is `(workspaceId, runId)`.** There is no "find by id and
 *     then check" path, because that is the shape that leaks a 403-vs-404
 *     difference and eventually leaks a row (§17.3).
 *   * **It creates nothing of its own that already exists.** The source project
 *     comes from `ProjectsService.create` and an upload from
 *     `MediaService.initUpload` — the same seams the ordinary home screen uses,
 *     so retention, plan limits, duplicate detection and the probe/proxy chain
 *     all apply unchanged (§2.1).
 *   * **It is off.** `repurpose_flow` gates the whole surface and is seeded
 *     disabled; `source_youtube_acquire` separately gates link sources, because
 *     the acquisition worker is Wave 3 and a run that can never progress is worse
 *     than a refusal that explains itself.
 */
@Injectable()
export class RepurposeService {
  private readonly logger = new Logger(RepurposeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly media: MediaService,
    private readonly styles: StylesService,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    private readonly realtime: RealtimePublisher,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Is a rollout flag on for this workspace?
   *
   * Two mechanisms, in the order they win. `FEATURE_FLAGS_JSON` is the deployment
   * kill switch: an explicit `false` there turns the feature off everywhere,
   * immediately, without a database write. Otherwise the `feature_flags` row
   * decides, including its targeting and hold-out lists, which
   * `EntitlementService` already evaluates and caches.
   */
  async flagEnabled(workspaceId: string, flag: string): Promise<boolean> {
    // eslint-disable-next-line security/detect-object-injection -- `flag` is one of the module's own constants, not input
    const override = this.env.FEATURE_FLAGS_JSON[flag];
    if (typeof override === "boolean") return override;

    const entitlement = await this.entitlements.forWorkspace(workspaceId);
    const flags = entitlement.entitlements.flags as Record<string, boolean> | undefined;
    // eslint-disable-next-line security/detect-object-injection -- as above
    return flags?.[flag] === true;
  }

  /**
   * The surface answers 404, not 403, when it is switched off.
   *
   * A feature nobody is entitled to see should not advertise its own existence,
   * and "not found" is the truthful answer for a route that is not serving.
   */
  private async assertAvailable(workspaceId: string): Promise<void> {
    if (await this.flagEnabled(workspaceId, REPURPOSE_FLAGS.flow)) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "This feature is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Entitlement check — a deliberate stub (REP-006 task 10).
   *
   * Wave 4 onward spends credits per source minute, and the plan's file and
   * duration caps are already enforced by `MediaService`. What is missing is a
   * per-plan allowance for runs themselves, which cannot be designed before the
   * cost model in §18.3 has real measurements. Until then this exists so that
   * later work has one place to put the rule rather than three.
   */
  private async assertEntitled(workspaceId: string): Promise<void> {
    await this.entitlements.forWorkspace(workspaceId);
  }

  /**
   * The chosen caption style has to exist, because the run FREEZES it.
   *
   * Without this the id is copied into `config` unchecked and the run fails much
   * later, at render, with nothing useful to say about why. Checking it against
   * the workspace's own catalogue — system styles plus its presets — is also what
   * makes `repurpose/style_unknown` a code that is thrown rather than reserved.
   */
  private async assertStyleExists(workspaceId: string, styleId: string): Promise<void> {
    const catalogue = await this.styles.list(workspaceId);
    if (catalogue.some((style) => style.id === styleId)) return;
    throw new AppException(
      REPURPOSE_ERRORS.styleUnknown,
      "That caption look is not available. Choose another one.",
      HttpStatus.BAD_REQUEST,
    );
  }

  async create(
    workspaceId: string,
    userId: string,
    input: CreateRunInput,
  ): Promise<CreateRunResponse> {
    await this.assertAvailable(workspaceId);
    await this.assertEntitled(workspaceId);

    const runId = ulid();
    // Everything that can refuse, refuses BEFORE the project row exists. That is
    // the only ordering in which a refusal leaves nothing behind at all.
    const source = await this.resolveSource(workspaceId, input);
    await this.assertStyleExists(workspaceId, input.setup.caption.styleId);

    const project = await this.projects.create(workspaceId, userId, {
      title: input.title ?? source.title,
      sourceLanguage: input.setup.sourceLanguage,
    });

    // Past this line a failure has already written a row, so it is compensated.
    // `initUpload` applies the plan's size and MIME caps, which makes it the first
    // refusal a beginner over the Free plan's 500 MB actually hits — and without
    // the compensation that refusal leaves a titled, empty project in their list.
    let upload;
    let run;
    try {
      upload =
        input.source.kind === "upload" && input.source.issueUploadTicket
          ? await this.media.initUpload(workspaceId, project.id, {
              filename: input.source.filename,
              size: input.source.sizeBytes,
              mime: input.source.mime,
              ...(input.source.contentHash === undefined
                ? {}
                : { contentHash: input.source.contentHash }),
            })
          : null;

      run = await this.prisma.repurposeRun.create({
        data: {
          id: runId,
          workspaceId,
          sourceProjectId: project.id,
          sourceKind: source.kind,
          sourceDisplay: source.display,
          sourceFingerprint: source.fingerprint,
          sourceUrlEncrypted: null,
          ...(source.kind === "upload"
            ? {}
            : { rightsAttestedAt: new Date(), rightsAttestedBy: userId }),
          mode: input.setup.discovery.mode,
          status: "draft",
          currentStage: "getting_video",
          requestedCandidates: input.setup.discovery.requestedCandidates,
          configVersion: 1,
          config: {
            schemaVersion: 1,
            sourceLanguage: input.setup.sourceLanguage,
            caption: { ...input.setup.caption, styleVersion: 1 },
            discovery: input.setup.discovery,
            // Formats and enhancements are chosen at Stage 3; the snapshot records
            // the defaults the run started from so a later change to those defaults
            // cannot reinterpret this run (§6.9).
            formats: [{ aspect: "9:16", destinations: [], reframe: "auto" }],
            enhancements: { audioClean: false, autoZoom: false, autoTextFx: false, music: "off" },
          },
          createdBy: userId,
        },
      });
    } catch (error) {
      // Best effort, and deliberately not fatal: a cleanup that fails must not
      // replace the real error with a cleanup error.
      await this.projects.softDelete(workspaceId, project.id).catch((cleanupError: unknown) => {
        this.logger.warn(
          { runId, projectId: project.id, err: cleanupError },
          "could not remove the source project after a failed run create",
        );
      });
      throw error;
    }

    await this.audit.record({
      action: "repurpose.run.created",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      // Safe fields only: never the full external URL, never the file's bytes.
      data: {
        sourceKind: run.sourceKind,
        sourceFingerprint: run.sourceFingerprint,
        mode: run.mode,
        duplicateUpload: upload?.duplicate ?? false,
      },
    });

    await this.publishStage(run);

    return {
      run: this.toView(run, { candidateCount: 0, clipCount: 0, variantCount: 0 }),
      projectId: project.id,
      upload:
        upload === null
          ? null
          : {
              mediaId: upload.mediaId,
              uploadId: upload.uploadId,
              key: upload.key,
              bucket: upload.bucket,
              partSizeBytes: upload.partSizeBytes,
              parts: upload.parts.map((part) => ({ partNumber: part.partNumber, url: part.url })),
              expiresAt: upload.expiresAt,
              duplicate: upload.duplicate,
            },
      next: { rel: "run", href: `/repurpose/${run.id}` },
    };
  }

  /**
   * Work out what the source is, and refuse early if we cannot honour it.
   *
   * An upload is trivially fine. A link has to survive the REP-009 normaliser,
   * the acquisition flag, and the "is this already running" check — in that
   * order, so a caller never learns about a duplicate run from a malformed URL.
   */
  private async resolveSource(
    workspaceId: string,
    input: CreateRunInput,
  ): Promise<{
    readonly kind: $Enums.RepurposeSourceKind;
    readonly display: string | null;
    readonly fingerprint: string | null;
    readonly title: string;
  }> {
    if (input.source.kind === "upload") {
      return {
        kind: "upload",
        display: null,
        fingerprint: null,
        title: input.source.filename.replace(/\.[^.]+$/, "").slice(0, 160) || "Untitled video",
      };
    }

    const parsed = parseSourceUrl(input.source.url);
    if (!parsed.ok) {
      throw new AppException(
        parsed.code === "unsupported_source"
          ? REPURPOSE_ERRORS.sourceUnsupported
          : REPURPOSE_ERRORS.sourceInvalidUrl,
        SOURCE_REJECTION_MESSAGES[parsed.code],
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!(await this.flagEnabled(workspaceId, REPURPOSE_FLAGS.youtubeAcquire))) {
      // BOTH link kinds are gated, not just YouTube. A `direct_media_url` has no
      // path to acquisition either — the existing safe fetcher is not wired to
      // this flow — and, worse, this service deliberately does not persist the
      // full URL (`sourceUrlEncrypted` stays null, §17.4), while the fingerprint
      // drops the query string that a signed media URL needs. So a direct-media
      // run created today would be unacquirable even once Wave 3 lands: the only
      // copy of the thing to fetch was in the request that created it.
      throw new AppException(
        REPURPOSE_ERRORS.sourceUnsupported,
        "Links are not available yet. Upload the video file instead.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const live = await this.prisma.repurposeRun.findFirst({
      where: {
        workspaceId,
        sourceFingerprint: parsed.source.sourceFingerprint,
        status: { notIn: ["published", "failed", "cancelled"] },
      },
      select: { id: true },
    });
    if (live !== null) {
      throw new AppException(
        REPURPOSE_ERRORS.sourceDuplicate,
        "You are already working on this video.",
        HttpStatus.CONFLICT,
      );
    }

    return {
      kind: parsed.source.kind,
      display: parsed.source.display,
      fingerprint: parsed.source.sourceFingerprint,
      title: parsed.source.display,
    };
  }

  async list(workspaceId: string, input: ListRunsInput): Promise<RunPage> {
    await this.assertAvailable(workspaceId);

    const runs = await this.prisma.repurposeRun.findMany({
      where: {
        workspaceId,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.cursor === undefined ? {} : { id: { lt: input.cursor } }),
      },
      // ULIDs sort by creation time, so one key orders and paginates.
      orderBy: { id: "desc" },
      take: input.limit + 1,
      include: { _count: { select: { candidates: true, clips: true } } },
    });

    const page = runs.slice(0, input.limit);
    return {
      items: page.map((run) =>
        this.toView(run, {
          candidateCount: run._count.candidates,
          clipCount: run._count.clips,
          variantCount: 0,
        }),
      ),
      nextCursor: runs.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(workspaceId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);
    const counts = await this.counts(run.id);
    return this.toView(run, counts, await this.observedStatus(run));
  }

  /**
   * What the run is ACTUALLY doing, read from its source project.
   *
   * `status` is the coarse value a list view reads, and it only moves when a
   * producer moves it. The producers for acquisition, discovery and
   * materialisation are later waves — but the source project is an ordinary
   * Aksharo project, so its media and its transcript are already being worked on
   * by the existing pipeline the moment the bytes land.
   *
   * §4.2 says exactly this: keep a coarse status for listing, derive detailed
   * progress from the child records. Without it the rail would sit on "Add a
   * video to get started" while the video was demonstrably being transcribed,
   * which is worse than showing nothing — it would be telling the user something
   * untrue about their own work.
   *
   * Returns null when the stored status is already ahead of what the project can
   * tell us, or when the run is finished, cancelled or failed: a derived view
   * must never walk a terminal run backwards.
   */
  private async observedStatus(run: RepurposeRun): Promise<$Enums.RepurposeRunStatus | null> {
    if (["failed", "cancelled", "published", "partially_published"].includes(run.status)) {
      return null;
    }
    // Only the earliest stages are derivable today; once discovery exists it
    // owns the transition out of `transcribing` and this stops at that line.
    if (!["draft", "acquiring", "preparing_media", "transcribing"].includes(run.status)) {
      return null;
    }

    const [media, transcript] = await Promise.all([
      this.prisma.mediaAsset.findFirst({
        where: { projectId: run.sourceProjectId, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: { status: true },
      }),
      this.prisma.transcript.findFirst({
        where: { projectId: run.sourceProjectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
    ]);

    if (transcript !== null) return "analyzing";
    if (media === null) return null;
    switch (media.status) {
      case "pending":
      case "uploading":
        return run.sourceKind === "upload" ? "draft" : "acquiring";
      case "uploaded":
      case "probing":
        return "preparing_media";
      case "ready":
        // Media is ready and no transcript exists yet: either it is being made,
        // or auto-transcription never started. Both read as "transcribing" to a
        // person, and the support code is how the difference gets diagnosed.
        return "transcribing";
      default:
        return null;
    }
  }

  async cancel(workspaceId: string, userId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);

    // Cancelling twice is not an error: the caller wanted it stopped and it is.
    if (run.status === "cancelled") return this.toView(run, await this.counts(run.id));

    if (!isCancellable(run.status)) {
      throw new AppException(
        REPURPOSE_ERRORS.notCancellable,
        "This run has already finished.",
        HttpStatus.CONFLICT,
      );
    }

    const cancelled = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        // The stage it stopped on is kept, so the rail can still show where.
        currentStage: stageForStatus(run.status),
      },
    });

    await this.audit.record({
      action: "repurpose.run.cancelled",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      data: { fromStatus: run.status },
    });
    await this.publishStage(cancelled);

    // Completed artefacts are deliberately left alone: cancelling stops future
    // work, it does not delete what the person already has (§4.2).
    return this.toView(cancelled, await this.counts(run.id));
  }

  async retry(workspaceId: string, userId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);

    if (!isRetryable(run.status)) {
      throw new AppException(
        REPURPOSE_ERRORS.notRetryable,
        "There is nothing to try again on this run.",
        HttpStatus.CONFLICT,
      );
    }

    // A failed run is OUTSIDE the live-source set, so the same video may already
    // have been started again. Moving this one back into that set would violate
    // `repurpose_runs_live_source_idx` and surface as a raw database conflict
    // instead of a sentence, so it is checked first and refused in our own words.
    if (run.sourceFingerprint !== null) {
      const live = await this.prisma.repurposeRun.findFirst({
        where: {
          workspaceId,
          sourceFingerprint: run.sourceFingerprint,
          id: { not: run.id },
          status: { notIn: ["published", "failed", "cancelled"] },
        },
        select: { id: true },
      });
      if (live !== null) {
        throw new AppException(
          REPURPOSE_ERRORS.sourceDuplicate,
          "You are already working on this video.",
          HttpStatus.CONFLICT,
        );
      }
    }

    // Clearing the failure and returning the run to the stage that owns the work
    // is the whole of retry today. Re-enqueueing arrives with each stage's
    // producer: acquisition in Wave 3, discovery in Wave 4, materialisation in
    // Wave 6. Until then a retried run waits rather than pretending to progress.
    const retried = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: { status: "draft", failureCode: null, progress: 0 },
    });

    await this.audit.record({
      action: "repurpose.run.retried",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      data: { fromStage: run.currentStage, fromFailureCode: run.failureCode },
    });
    await this.publishStage(retried);

    return this.toView(retried, await this.counts(run.id));
  }

  /** The only way this module reads a run: workspace and id, together. */
  private async require(workspaceId: string, runId: string): Promise<RepurposeRun> {
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

  private async counts(
    runId: string,
  ): Promise<{ candidateCount: number; clipCount: number; variantCount: number }> {
    const [candidateCount, clipCount, variantCount] = await Promise.all([
      this.prisma.clipCandidate.count({ where: { runId } }),
      this.prisma.repurposeClip.count({ where: { runId } }),
      this.prisma.clipVariant.count({ where: { clip: { runId } } }),
    ]);
    return { candidateCount, clipCount, variantCount };
  }

  /**
   * Stage changes go to the workspace room, not the project room.
   *
   * The run is what a person is watching, and it outlives any one project: the
   * source project and every child variant project belong to it. Publishing is
   * fire and forget — `RealtimePublisher` swallows its own failures, because a
   * missed event costs a refetch and a failed request costs the run.
   */
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

  private toView(
    run: RepurposeRun,
    counts: { candidateCount: number; clipCount: number; variantCount: number },
    observed: $Enums.RepurposeRunStatus | null = null,
  ): RunView {
    const projection = projectRun(observed === null ? run : { ...run, status: observed });
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceProjectId: run.sourceProjectId,
      sourceKind: run.sourceKind,
      sourceDisplay: run.sourceDisplay,
      mode: run.mode,
      status: observed ?? run.status,
      currentStage: projection.currentStage,
      progress: projection.progress,
      stages: projection.stages.map((stage) => ({ ...stage })),
      message: projection.message,
      failureCode: run.failureCode,
      canCancel: projection.canCancel,
      canRetry: projection.canRetry,
      ...counts,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    };
  }
}
