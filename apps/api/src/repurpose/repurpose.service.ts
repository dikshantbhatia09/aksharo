import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ulid } from "ulid";

import type { Env } from "@montaj/config";
import {
  type HighlightsPayload,
  MediaAcquirePayloadSchema,
  type MediaClipPayload,
  REPURPOSE_SCHEMA_VERSION,
  highlightsJobKey,
  mediaAcquireJobKey,
  mediaClipJobKey,
} from "@montaj/repurpose-contracts";

import {
  ACQUIRE_QUOTE_TENTHS,
  ACQUIRE_TIMEOUT_MS,
  ACQUIRED_FILENAME,
  ACQUIRED_MIME,
  CLIP_PROFILE_VERSION,
  DEFAULT_STAGE_DEADLINES_MS,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  STAGE_TIMEOUT_CUSTOMER_MESSAGE,
} from "./repurpose.constants.js";
import { isCancellable, isRetryable, projectRun, stageForStatus } from "./repurpose.projection.js";
import { SOURCE_REJECTION_MESSAGES, parseSourceUrl } from "./source-url.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { CREDITS_FACADE, type CreditsFacade } from "../credits/credits.facade.js";
import { JobsService } from "../jobs/jobs.service.js";
import { MediaService } from "../media/media.service.js";
import { mediaLimitsFor } from "../projects/plan-limits.js";
import { ProjectsService } from "../projects/projects.service.js";
import { workspaceRoom } from "../realtime/realtime.protocol.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";
import { StylesService } from "../styles/styles.service.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type {
  CreateRunInput,
  CreateRunResponse,
  ListRunsInput,
  RunPage,
  RunView,
} from "./repurpose.dto.js";
import type { AcquisitionProject } from "../media/media.service.js";
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
    private readonly jobs: JobsService,
    @Inject(ENV) private readonly env: Env,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
    @Optional() @Inject(DERIVED_STORE) private readonly derivedStore?: ObjectStore,
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
    let acquireJobId: string | null = null;
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

      // A link source has no browser to push bytes, so the fetch is started
      // here, in the same compensated block: a workspace that is over its
      // admission limit refuses the run outright rather than leaving a project,
      // a run and a media row behind for a download nothing ever queued.
      if (source.normalizedUrl !== null) {
        acquireJobId = await this.startAcquisition(workspaceId, project, run, {
          kind: source.kind,
          fingerprint: source.fingerprint,
          normalizedUrl: source.normalizedUrl,
        });
      }
    } catch (error) {
      // Best effort, and deliberately not fatal: a cleanup that fails must not
      // replace the real error with a cleanup error.
      //
      // The run row is removed outright rather than marked failed. It is the
      // acquisition enqueue that can now fail here, AFTER the run exists, and a
      // create that answered with an error must not also leave a dead run in the
      // person's list — from their side it never started.
      if (run !== undefined) {
        await this.prisma.repurposeRun
          .delete({ where: { id: run.id } })
          .catch((cleanupError: unknown) => {
            this.logger.warn(
              { runId, err: cleanupError },
              "could not remove the run after a failed run create",
            );
          });
      }
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
        acquireJobId,
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
    /**
     * The canonical URL to fetch — held only as long as this request, and handed
     * straight to the acquisition job. The run row still does not persist it
     * (§17.4): `media.acquire`'s payload is where the contract puts the address,
     * and that job is the only thing that needs it.
     */
    readonly normalizedUrl: string | null;
  }> {
    if (input.source.kind === "upload") {
      return {
        kind: "upload",
        display: null,
        fingerprint: null,
        normalizedUrl: null,
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
      // BOTH link kinds are gated, not just YouTube: with the flag off there is
      // no consumer for `media.acquire` at all, and a run that can never progress
      // is worse than a refusal a person can act on.
      throw new AppException(
        REPURPOSE_ERRORS.sourceUnsupported,
        "Links are not available yet. Upload the video file instead.",
        HttpStatus.BAD_REQUEST,
      );
    }

    if (parsed.source.kind === "direct_media_url") {
      // Acquisition is enabled for the PROVIDER path only. A direct media URL is
      // an arbitrary host chosen by the caller, and `parseSourceUrl` deliberately
      // does not resolve it — so accepting one would point a downloader running
      // on this machine at any address that ends in `.mp4`, including addresses
      // only this machine can reach. That needs an egress policy (SSRF: no
      // private ranges, no link-local, no redirect off-host), and until one
      // exists this stays refused even with the flag on.
      throw new AppException(
        REPURPOSE_ERRORS.sourceUnsupported,
        "Direct file links are not supported yet. Paste a YouTube link, or upload the video file.",
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
      normalizedUrl: parsed.source.normalizedUrl,
      title: parsed.source.display,
    };
  }

  /**
   * Enqueue the fetch for a link-sourced run.
   *
   * This is the producer half of REP-010. It runs inside `create`'s compensated
   * block, so a workspace that is over its admission limit refuses the run
   * outright rather than leaving a project, a run and a media row behind for a
   * download that was never queued.
   *
   * The job key is the run and the SOURCE, not the media row
   * (`mediaAcquireJobKey`): ten submissions of the same video inside one run are
   * one download (§9.5). The limits are resolved here, from the plan in force at
   * confirmation time, and travel in the payload — a worker never reads
   * entitlements.
   */
  private async startAcquisition(
    workspaceId: string,
    project: AcquisitionProject,
    run: RepurposeRun,
    source: {
      readonly kind: $Enums.RepurposeSourceKind;
      readonly fingerprint: string | null;
      readonly normalizedUrl: string;
    },
  ): Promise<string> {
    const limits = mediaLimitsFor(await this.entitlements.forWorkspace(workspaceId));
    const reserved = await this.media.reserveAcquisition(project, {
      filename: ACQUIRED_FILENAME,
      mime: ACQUIRED_MIME,
    });

    // Parsed, not assembled: the contract is the wire format both runtimes agree
    // on, so building the object and hoping is not good enough (§8.1).
    const payload = MediaAcquirePayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: run.id,
      projectId: project.id,
      mediaId: reserved.media.id,
      source: {
        kind: source.kind === "youtube_url" ? "youtube_url" : "direct_media_url",
        normalizedUrl: source.normalizedUrl,
        sourceId: source.fingerprint,
      },
      destination: { bucket: reserved.bucket, key: reserved.key },
      limits: {
        maxBytes: limits.maxFileBytes,
        maxDurationMs: limits.maxDurationMs,
        timeoutMs: ACQUIRE_TIMEOUT_MS,
      },
    });

    const enqueued = await this.jobs.enqueue({
      type: "media.acquire",
      workspaceId,
      projectId: project.id,
      params: payload,
      jobKey: mediaAcquireJobKey(run.id, source.fingerprint ?? run.id),
      worstCaseTenths: ACQUIRE_QUOTE_TENTHS,
      reason: `media.acquire · ${run.id}`,
    });
    return enqueued.job.id;
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
    // Same derivation `get()` uses, and for the same reason: without it, a run
    // whose transcript already exists still reads "Add a video to get started"
    // on any list view, because nothing writes `status` past `draft` for these
    // early stages (see `observedStatus`). The home page pipeline banner is a
    // list view, so it needs this exactly as much as the run's own detail page.
    const observed = await Promise.all(page.map((run) => this.observedStatus(run)));
    return {
      items: page.map((run, index) =>
        this.toView(
          run,
          {
            candidateCount: run._count.candidates,
            clipCount: run._count.clips,
            variantCount: 0,
          },
          // eslint-disable-next-line security/detect-object-injection -- index bounded by page.map
          observed[index],
        ),
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

    // `run.status` is the raw stored column, which for the early stages is
    // never written past "draft" (§4.2, `observedStatus`) -- a run visibly on
    // "Finding promising moments" when the person clicked Stop is still
    // `status: "draft"` in the row. Freezing on `stageForStatus(run.status)`
    // unconditionally therefore always froze a cancelled run at "getting_video"
    // regardless of how far it had actually gotten, because the intent --
    // "the stage it stopped on is kept" -- was implemented against the wrong
    // status. The observed status is what the person was actually looking at.
    const observed = await this.observedStatus(run);
    const cancelled = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        // The stage it stopped on is kept, so the rail can still show where.
        currentStage: stageForStatus(observed ?? run.status),
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
  /**
   * Public because the acquisition completion handler announces stages too: a
   * fetch that failed has to reach the open tab, and the alternative — a second
   * copy of the projection over in the handler — is how two surfaces start
   * disagreeing about what a run is doing.
   */
  async publishStage(run: RepurposeRun): Promise<void> {
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

  async startHighlightDiscovery(run: RepurposeRun, transcriptId: string): Promise<string> {
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { id: true, currentRevision: true },
    });
    const revision = transcript?.currentRevision ?? 1;

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });

    const config = (run.config as Record<string, unknown>) ?? {};
    const discovery = (config["discovery"] as Record<string, unknown>) ?? {};
    const sourceLanguage =
      typeof config["sourceLanguage"] === "string" ? config["sourceLanguage"] : "en";

    const proxyKey = media?.storageKey
      ? media.storageKey.replace(/raw\.[^.]+$/, "proxy540.mp4")
      : `ws/${run.workspaceId}/p/${run.sourceProjectId}/media/${media?.id ?? "unknown"}/proxy540.mp4`;

    const payload: HighlightsPayload = {
      schemaVersion: 1,
      runId: run.id,
      projectId: run.sourceProjectId,
      transcriptId,
      transcriptRevision: revision,
      proxy: {
        bucket: "s3",
        key: proxyKey,
      },
      waveform: null,
      options: {
        count: run.requestedCandidates || (discovery["requestedCandidates"] as number) || 5,
        minDurationMs: (discovery["minDurationMs"] as number) || 15_000,
        maxDurationMs: (discovery["maxDurationMs"] as number) || 60_000,
        contentGoal:
          (discovery["contentGoal"] as "reach" | "education" | "authority" | "engagement") ||
          "reach",
        language: sourceLanguage || "hi-Latn",
      },
      promptVersion: "highlights-v1",
      featureVersion: "features-v1",
    };

    const enqueued = await this.jobs.enqueue({
      type: "ai.highlights",
      workspaceId: run.workspaceId,
      projectId: run.sourceProjectId,
      params: payload,
      jobKey: highlightsJobKey(run.id, transcriptId, revision, "default"),
      worstCaseTenths: 0,
      reason: `ai.highlights · ${run.id}`,
    });

    const updated = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "analyzing",
        currentStage: "finding_clips",
        progress: 45,
      },
    });
    await this.publishStage(updated);

    return enqueued.job.id;
  }

  async listCandidates(workspaceId: string, runId: string) {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);
    const candidates = await this.prisma.clipCandidate.findMany({
      where: { runId: run.id },
      orderBy: [{ rank: "asc" }, { potentialScore: "desc" }],
    });
    return {
      runId: run.id,
      candidates,
    };
  }

  async createClip(workspaceId: string, userId: string, runId: string, candidateId: string) {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);
    const candidate = await this.prisma.clipCandidate.findFirst({
      where: { id: candidateId, runId: run.id },
    });
    if (!candidate) {
      throw new AppException(
        REPURPOSE_ERRORS.notFound,
        "Clip candidate not found",
        HttpStatus.NOT_FOUND,
      );
    }

    let clip = await this.prisma.repurposeClip.findUnique({
      where: { candidateId: candidate.id },
    });

    if (!clip) {
      clip = await this.prisma.repurposeClip.create({
        data: {
          id: ulid(),
          runId: run.id,
          candidateId: candidate.id,
          title: candidate.title,
          sourceStartMs: candidate.startMs,
          sourceEndMs: candidate.endMs,
        },
      });
    }

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });

    if (!media || !media.storageKey) {
      throw new AppException(
        REPURPOSE_ERRORS.sourceUnsupported,
        "Source media asset is not ready",
        HttpStatus.BAD_REQUEST,
      );
    }

    const destKey = `ws/${workspaceId}/p/${run.sourceProjectId}/repurpose/${run.id}/clips/${candidate.id}/master.mp4`;

    // No `subtitles`: the mezzanine is the clip project's primary media, and
    // captions burned into it sat under every caption the editor drew and every
    // export (2026-09-25). Captions come from the clip's editing document; the
    // run page overlays the clip transcript as a text track for its preview.
    const payload: MediaClipPayload = {
      schemaVersion: 1,
      runId: run.id,
      candidateId: candidate.id,
      clipId: clip.id,
      source: {
        bucket: "s3",
        key: media.storageKey,
      },
      sourceDurationMs: media.durationMs ?? candidate.endMs + 5000,
      startMs: candidate.startMs,
      endMs: candidate.endMs,
      handleMs: 500,
      destination: {
        bucket: "s3",
        key: destKey,
      },
      profile: {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        maxHeight: 1080,
      },
      profileVersion: CLIP_PROFILE_VERSION,
    };

    const enqueued = await this.jobs.enqueue({
      type: "media.clip",
      workspaceId,
      projectId: run.sourceProjectId,
      params: payload,
      jobKey: mediaClipJobKey(
        candidate.id,
        `${candidate.startMs}-${candidate.endMs}`,
        CLIP_PROFILE_VERSION,
      ),
      worstCaseTenths: 0,
      reason: `media.clip · ${clip.id}`,
    });

    const updated = await this.prisma.repurposeRun.update({
      where: { id: run.id },
      data: {
        status: "materializing",
        currentStage: "styles_formats",
        progress: 65,
      },
    });
    await this.publishStage(updated);

    return {
      clipId: clip.id,
      jobId: enqueued.job.id,
      status: "materializing",
    };
  }

  async listClips(workspaceId: string, runId: string) {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);
    const clips = await this.prisma.repurposeClip.findMany({
      where: { runId: run.id },
      include: {
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
      },
      orderBy: { createdAt: "asc" },
    });

    const enriched = await Promise.all(
      clips.map(async (clip) => {
        let mezzanineUrl: string | null = null;
        if (clip.mezzanineKey && this.derivedStore) {
          try {
            mezzanineUrl = await this.derivedStore.presignGet(clip.mezzanineKey, 3600);
          } catch {
            // ignore
          }
        }
        return {
          ...clip,
          mezzanineUrl,
        };
      }),
    );

    const serialized = JSON.parse(
      JSON.stringify(enriched, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    );

    return { runId: run.id, clips: serialized };
  }

  async getPreview(workspaceId: string, runId: string) {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);
    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });

    let previewUrl: string | null = null;
    let durationMs = 0;
    if (media) {
      durationMs = media.durationMs ?? 0;
      const key = media.proxyKey ?? media.storageKey;
      if (key && this.derivedStore) {
        try {
          previewUrl = await this.derivedStore.presignGet(key, 3600);
        } catch {
          // ignore
        }
      }
    }
    return {
      runId: run.id,
      projectId: run.sourceProjectId,
      durationMs,
      previewUrl,
    };
  }

  async sweepStuckRuns(
    now: Date = new Date(),
    customDeadlines?: Record<string, number>,
  ): Promise<StuckRunsSweepReport> {
    const deadlines: Record<string, number> = {
      ...DEFAULT_STAGE_DEADLINES_MS,
      ...customDeadlines,
    };

    const inFlightStatuses: $Enums.RepurposeRunStatus[] = [
      "draft",
      "acquiring",
      "preparing_media",
      "transcribing",
      "analyzing",
      "materializing",
      "rendering",
      "publishing",
    ];

    const runs = await this.prisma.repurposeRun.findMany({
      where: {
        status: { in: inFlightStatuses },
      },
    });

    const failedRuns: string[] = [];
    const releasedHolds: string[] = [];

    for (const run of runs) {
      // 1. Derive current stage the same way get()/list() do
      const observed = await this.observedStatus(run);
      const effectiveStatus = observed ?? run.status;

      // Skip terminal runs
      if (
        ["failed", "cancelled", "published", "partially_published"].includes(effectiveStatus) ||
        ["failed", "cancelled", "published"].includes(run.status)
      ) {
        continue;
      }

      // 2. Never time out a run that is waiting on the customer:
      // - a draft with no media uploaded yet
      // - candidates_ready
      // - review_ready / review
      if (effectiveStatus === "candidates_ready" || run.status === "candidates_ready") {
        continue;
      }

      const currentStage = stageForStatus(effectiveStatus);
      if (
        currentStage === "review" ||
        ["review_ready", "changes_requested", "approved"].includes(effectiveStatus) ||
        ["review_ready", "changes_requested", "approved"].includes(run.status)
      ) {
        continue;
      }

      if (run.sourceKind === "upload" && (run.status === "draft" || effectiveStatus === "draft")) {
        const primaryMedia = await this.prisma.mediaAsset.findFirst({
          where: { projectId: run.sourceProjectId, role: "primary" },
          orderBy: { createdAt: "desc" },
          select: { status: true },
        });
        if (
          primaryMedia === null ||
          primaryMedia.status === "pending" ||
          primaryMedia.status === "uploading"
        ) {
          continue;
        }
      }

      const deadlineMs = getStageDeadline(deadlines, currentStage);
      if (deadlineMs <= 0) continue;

      // 3. Find only jobs belonging to this run (media.acquire, ai.highlights, media.clip)
      const candidateJobs = await this.prisma.job.findMany({
        where: {
          workspaceId: run.workspaceId,
          type: { in: ["media.acquire", "ai.highlights", "media.clip"] },
        },
        include: {
          events: {
            orderBy: { at: "desc" },
            take: 1,
            select: { at: true },
          },
          creditHold: {
            select: { id: true, status: true },
          },
        },
      });

      const runJobs = candidateJobs.filter((job) => {
        const params =
          typeof job.params === "object" && job.params !== null
            ? (job.params as Record<string, unknown>)
            : {};
        if (params["runId"] === run.id) return true;
        if (job.jobKey.startsWith(`media.acquire:${run.id}`)) return true;
        if (job.jobKey.startsWith(`ai.highlights:${run.id}`)) return true;
        if (job.jobKey.startsWith(`media.clip:${run.id}`)) return true;
        return false;
      });

      // 4. Measure elapsed time from real progress signals:
      // source media, transcript (and its chunks / transcription jobs), and the run's own jobs
      const timestamps: number[] = [run.createdAt.getTime()];

      const mediaAssets = await this.prisma.mediaAsset.findMany({
        where: { projectId: run.sourceProjectId },
        select: { createdAt: true, uploadedAt: true },
      });
      for (const m of mediaAssets) {
        timestamps.push(m.createdAt.getTime());
        if (m.uploadedAt) timestamps.push(m.uploadedAt.getTime());
      }

      const transcripts = await this.prisma.transcript.findMany({
        where: { projectId: run.sourceProjectId },
        select: { id: true, createdAt: true },
      });
      for (const t of transcripts) {
        timestamps.push(t.createdAt.getTime());
      }

      if (transcripts.length > 0) {
        const latestChunk = await this.prisma.transcriptChunk.findFirst({
          where: { transcriptId: { in: transcripts.map((t) => t.id) } },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (latestChunk) {
          timestamps.push(latestChunk.createdAt.getTime());
        }
      }

      const transcribeJobs = await this.prisma.job.findMany({
        where: {
          projectId: run.sourceProjectId,
          type: { in: ["ai.transcribe", "ai.align"] },
        },
        select: { queuedAt: true, startedAt: true, finishedAt: true },
      });
      for (const tj of transcribeJobs) {
        timestamps.push(tj.queuedAt.getTime());
        if (tj.startedAt) timestamps.push(tj.startedAt.getTime());
        if (tj.finishedAt) timestamps.push(tj.finishedAt.getTime());
      }

      for (const rj of runJobs) {
        timestamps.push(rj.queuedAt.getTime());
        if (rj.startedAt) timestamps.push(rj.startedAt.getTime());
        if (rj.finishedAt) timestamps.push(rj.finishedAt.getTime());
        if (rj.events.length > 0 && rj.events[0]) {
          timestamps.push(rj.events[0].at.getTime());
        }
      }

      const [latestCandidate, latestClip] = await Promise.all([
        this.prisma.clipCandidate.findFirst({
          where: { runId: run.id },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        }),
        this.prisma.repurposeClip.findFirst({
          where: { runId: run.id },
          orderBy: { updatedAt: "desc" },
          select: { createdAt: true, updatedAt: true },
        }),
      ]);
      if (latestCandidate) timestamps.push(latestCandidate.createdAt.getTime());
      if (latestClip) {
        timestamps.push(latestClip.createdAt.getTime());
        timestamps.push(latestClip.updatedAt.getTime());
      }

      const lastProgressAtMs = Math.max(...timestamps);
      const elapsedMs = now.getTime() - lastProgressAtMs;

      if (elapsedMs < deadlineMs) {
        continue;
      }

      this.logger.warn(
        {
          runId: run.id,
          stage: currentStage,
          status: run.status,
          effectiveStatus,
          elapsedMs,
          deadlineMs,
        },
        "Repurpose run exceeded stage deadline; moving to failed state and releasing holds",
      );

      // 1. Move run to terminal failed state
      await this.prisma.repurposeRun.update({
        where: { id: run.id },
        data: {
          status: "failed",
          failureCode: REPURPOSE_ERRORS.stageTimeout,
          currentStage,
        },
      });

      // 2. Publish realtime event with customer-readable message
      await this.realtime.publish(workspaceRoom(run.workspaceId), "repurpose.stage.changed", {
        runId: run.id,
        status: "failed",
        stage: currentStage,
        progress: run.progress,
        message: STAGE_TIMEOUT_CUSTOMER_MESSAGE,
        at: now.toISOString(),
      });

      // 3. Record audit event
      await this.audit.record({
        action: "repurpose.run.timed_out",
        resource: "repurpose_run",
        resourceId: run.id,
        actorId: "system",
        workspaceId: run.workspaceId,
        data: {
          reason: "stage_timeout",
          stage: currentStage,
          fromStatus: run.status,
          elapsedMs,
          deadlineMs,
        },
      });

      failedRuns.push(run.id);

      // 4. Release only holds with status "held" that belong to this run's jobs
      const runJobIds = runJobs.map((j) => j.id);
      if (runJobIds.length > 0) {
        const heldHolds = await this.prisma.creditHold.findMany({
          where: {
            jobId: { in: runJobIds },
            status: "held",
          },
          select: { id: true },
        });

        for (const hold of heldHolds) {
          try {
            await this.credits.release({ holdId: hold.id });
            releasedHolds.push(hold.id);
          } catch (err) {
            this.logger.warn(
              { holdId: hold.id, runId: run.id, err },
              "failed to release credit hold for stuck run",
            );
          }
        }

        // Direct holds from job.creditHoldId if not present in credit_holds table (or if status is held)
        const directHoldIds = runJobs
          .map((j) => j.creditHoldId)
          .filter((id): id is string => typeof id === "string" && !releasedHolds.includes(id));

        for (const holdId of directHoldIds) {
          const existingHold = await this.prisma.creditHold.findUnique({
            where: { id: holdId },
            select: { status: true },
          });
          if (!existingHold || existingHold.status === "held") {
            try {
              await this.credits.release({ holdId });
              releasedHolds.push(holdId);
            } catch (err) {
              this.logger.warn(
                { holdId, runId: run.id, err },
                "failed to release credit hold for stuck run",
              );
            }
          }
        }
      }

      // 5. Cancel in-flight jobs that belong to this run only
      const inFlightRunJobIds = runJobs
        .filter((j) => j.status === "queued" || j.status === "running")
        .map((j) => j.id);

      if (inFlightRunJobIds.length > 0) {
        await this.prisma.job.updateMany({
          where: {
            id: { in: inFlightRunJobIds },
            status: { in: ["queued", "running"] },
          },
          data: {
            status: "cancelled",
            finishedAt: now,
          },
        });
      }
    }

    return {
      examined: runs.length,
      failedRuns,
      releasedHolds,
    };
  }
}

function getStageDeadline(deadlines: Record<string, number>, stage: string): number {
  switch (stage) {
    case "getting_video":
      return deadlines.getting_video ?? (30 * 60 * 1000);
    case "finding_clips":
      return deadlines.finding_clips ?? (30 * 60 * 1000);
    case "styles_formats":
      return deadlines.styles_formats ?? (30 * 60 * 1000);
    case "review":
      return deadlines.review ?? (30 * 60 * 1000);
    case "publish":
      return deadlines.publish ?? (30 * 60 * 1000);
    default:
      return 30 * 60 * 1000;
  }
}

export interface StuckRunsSweepReport {
  readonly examined: number;
  readonly failedRuns: string[];
  readonly releasedHolds: string[];
}
