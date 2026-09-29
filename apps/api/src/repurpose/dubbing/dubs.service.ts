import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ulid } from "ulid";

import { formatCredits, type Env } from "@montaj/config";
import type { Word } from "@montaj/edg/schemas";
import {
  AiDubPayloadSchema,
  CLIP_VIDEO_KEY_PATTERN,
  DUB_LIMITS,
  DubCheckpointSchema,
  DubTrackSchema,
  MediaDubPayloadSchema,
  REPURPOSE_SCHEMA_VERSION,
  VIDEO_SHAPES,
  aiDubCancelJobKey,
  aiDubJobKey,
  dubFolder,
  dubVideoKey,
  mediaDubJobKey,
  type DubLanguage,
  type DubTrack,
  type VideoShape,
} from "@montaj/repurpose-contracts";

import { awaitingPictureFaces } from "../reframe.js";
import {
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  RECONCILE_INTERVAL_MS,
  SHAPE_OF_ASPECT,
} from "../repurpose.constants.js";
import { isRemoved } from "../steering.js";
import { DubBudget } from "./dub-budget.js";
import {
  DUB_LANGUAGE_OPTIONS,
  dubLanguageOption,
  isDubLanguage,
  vendorLanguageOf,
  type DubLanguageOption,
} from "./dub-languages.js";
import { DUB_TENTHS_PER_MINUTE, dubCostTenths, dubVendorPaise } from "./dub-pricing.js";
import {
  DEFINITIVE_FAILURES,
  DUB_CAPTIONED_QUIET_MS,
  DUB_CONSENT_STATEMENT,
  DUB_CONSENT_VERSION,
  DUB_ERRORS,
  DUB_FLAG,
  DUB_MUX_ATTEMPTS,
  DUB_RENDER_ATTEMPTS,
  DUB_SWEEP_BATCH,
  DUB_URL_TTL_SECONDS,
  MAX_LIVE_DUBS_PER_WORKSPACE,
  NOT_RETRYABLE_FAILURES,
  VENDOR_WORDS,
  dubOriginalBedDb,
} from "./dubs.constants.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../../common/storage/index.js";
import { ENV } from "../../config/config.module.js";
import { newestChunkRows } from "../../edg/chunk-rows.js";
import { ExportsService } from "../../exports/exports.service.js";
import { planLimits } from "../../jobs/jobs.config.js";
import { JOB_ERROR_CODES } from "../../jobs/jobs.errors.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { resolveWorkspacePlan } from "../../jobs/plan.js";
import { facesJobKey } from "../../media/faces.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";

import type { CreateDubInput } from "./dubs.dto.js";
import type { $Enums, ClipDub, Prisma, RepurposeRun } from "@prisma/client";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A dubbed shape's captioned video: `rendering` while made, then as a clip's. */
export interface DubCaptionedView {
  readonly status: "rendering" | "ready" | "stale" | "failed";
  readonly playUrl: string | null;
  readonly downloadUrl: string | null;
}

/** One shape of one language: `preparing` until its picture and captions are ready. */
export interface DubFormatView {
  readonly shape: VideoShape;
  readonly status: "preparing" | "rendering" | "ready" | "stale" | "failed";
  readonly projectId: string | null;
  readonly captioned: DubCaptionedView | null;
  readonly cleanUrl: string | null;
}

export interface DubLanguageView extends DubLanguageOption {
  readonly status: "queued" | "dubbing" | "making" | "ready" | "failed" | "cancelled";
  /** Why a language failed, in words (the vendor's own for its refusals). */
  readonly reason: string | null;
  readonly formats: readonly DubFormatView[];
}

/**
 * A dub as `GET .../dubs` returns it. `progress` and `step` are the vendor's own
 * percent and step label while it dubs ("Cloning the voice").
 */
export interface DubView {
  readonly id: string;
  readonly runId: string;
  readonly clipId: string;
  readonly status: $Enums.DubStatus;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly sourceLanguage: DubLanguageOption;
  readonly languages: readonly DubLanguageView[];
  readonly durationMs: number;
  readonly costTenths: number;
  readonly progress: number | null;
  readonly step: string | null;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What a clip offers the "Dub into…" dialog: its language (null when the
 * vendor cannot dub from it), its length (the price), the languages already
 * dubbed or being dubbed, and why it cannot be dubbed yet, if it cannot.
 */
export interface DubOfferView {
  readonly clipId: string;
  readonly ready: boolean;
  readonly sourceLanguage: DubLanguageOption | null;
  readonly durationMs: number | null;
  readonly taken: readonly DubLanguage[];
}

export interface DubListView {
  readonly runId: string;
  /** `repurpose_dubbing` is on for this workspace: the page offers Dub. */
  readonly enabled: boolean;
  /** Credits (tenths) per minute of clip per language. */
  readonly tenthsPerMinute: number;
  readonly languages: readonly DubLanguageOption[];
  readonly clips: readonly DubOfferView[];
  readonly dubs: readonly DubView[];
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** A clip with each shape's project, its primary media and its newest transcript. */
const CLIP_SHAPES_INCLUDE = {
  candidate: true,
  variants: {
    include: {
      project: {
        select: {
          id: true,
          mediaAssets: {
            where: { role: "primary" },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          transcripts: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { id: true, language: true },
          },
        },
      },
    },
  },
} as const satisfies Prisma.RepurposeClipInclude;

type ClipWithShapes = Prisma.RepurposeClipGetPayload<{ include: typeof CLIP_SHAPES_INCLUDE }>;

/** A dub with each of its shapes' projects: their picture, document and exports. */
const DUB_INCLUDE = {
  variants: {
    include: {
      latestExport: { select: { id: true, status: true, storageKey: true } },
      project: {
        select: {
          edgDocument: { select: { revision: true, updatedAt: true } },
          mediaAssets: {
            where: { role: "primary" },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          exports: {
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true, storageKey: true },
          },
        },
      },
    },
  },
} as const satisfies Prisma.ClipDubInclude;

type DubWithShapes = Prisma.ClipDubGetPayload<{ include: typeof DUB_INCLUDE }>;
type DubShapeRow = DubWithShapes["variants"][number];

/** Dubs the watchdog carries on, whatever their run is doing. */
const LIVE_DUB_STATUSES: readonly $Enums.DubStatus[] = ["waiting", "dubbing", "making"];

/** The render each shape's captioned video is made at, as `captionClips` makes a clip's. */
const RENDER_SIZE_OF_ASPECT = {
  r9x16: { preset: "reels" },
  r4x5: { preset: "instagram-feed" },
  r1x1: { preset: "square" },
  r16x9: { preset: "custom", customWidth: 1920, customHeight: 1080 },
} as const;

/**
 * A clip dubbed into other languages, in the speaker's own voice (2026-10-04).
 *
 * One request is ONE vendor job (Sarvam's Dubbing API, `ai.dub` in worker-ai)
 * for every language asked for; then every language is laid under every shape
 * the clip has (`media.dub` in worker-media), each as its own project with a
 * transcript made from the vendor's SRT, its editing document, its face track
 * and a captioned video in the run's caption style - the same way Autopilot's
 * shapes are made, from the clean pictures, so nothing in the clip's language
 * (a hook title, a series label) comes with it.
 *
 * What it holds to:
 *
 *   * **Consent before cloning.** A dub needs the person's tick that they may
 *     use and clone the speaker's voice; who and when are on the dub, and in
 *     `audit_log` with the sentence they agreed to.
 *   * **Money is decided before anything starts.** The request's credits
 *     (25 a minute a language) must be in the balance and within what the plan
 *     may hold at once, and its rupees must fit today's dubbing budget, which
 *     is charged atomically at request time. The credits are held on the
 *     `ai.dub` job: settled on the languages that came back, released when the
 *     dub fails. The rupees are given back only when no vendor job ever started.
 *   * **The vendor is paid once.** The worker records the vendor's job id on
 *     its job before starting it; a failed dub that did not definitively fail
 *     at the vendor resumes the SAME vendor job on Retry (free), and the budget
 *     is not charged again for it.
 *   * **A full plan lane is a wait.** A dub asked for then is kept `waiting`
 *     and started by the reconcile, as are its shapes and captioned videos.
 *   * **Cancel stops the vendor too**: the job is cancelled, and a cancel job
 *     stops the vendor's; the credits come back.
 */
@Injectable()
export class RepurposeDubsService {
  private readonly logger = new Logger(RepurposeDubsService.name);
  /** When each run's dubs were last reconciled from a read. Per process. */
  private readonly reconciledAt = new Map<string, number>();
  /** Dubs being reconciled after a completion, and whether one more pass was asked for. */
  private readonly reconciling = new Map<string, { again: boolean; done: Promise<void> }>();
  /**
   * Passes that failed to ask for a shape's captioned video with an error
   * that is not a refusal. In memory, like the clips service's: a restart is a
   * fresh start, and a lasting fault still ends `failed` a few passes later.
   */
  private readonly captionRequestErrors = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    private readonly budget: DubBudget,
    @Inject(ENV) private readonly env: Env,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
    /** Makes each dubbed shape's captioned video; absent in hand-built harnesses. */
    @Optional() private readonly exports?: ExportsService,
  ) {}

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  async list(workspaceId: string, runId: string): Promise<DubListView> {
    await this.assertFlow(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const enabled = await this.dubbingEnabled(workspaceId);
    if (this.dueForReconcile(run.id)) {
      await this.reconcileRun(run.id).catch((error: unknown) => {
        this.logger.warn({ runId: run.id, err: error }, "dub reconcile failed; the list is served");
      });
    }
    const [clips, dubs] = await Promise.all([
      this.clipsOf(run.id),
      this.prisma.clipDub.findMany({
        where: { runId: run.id },
        include: DUB_INCLUDE,
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const shown = new Set(clips.filter((clip) => !isRemoved(clip.candidate)).map((c) => c.id));
    const visible = dubs.filter((dub) => shown.has(dub.clipId));
    return {
      runId: run.id,
      enabled,
      tenthsPerMinute: DUB_TENTHS_PER_MINUTE,
      languages: DUB_LANGUAGE_OPTIONS,
      clips: clips
        .filter((clip) => !isRemoved(clip.candidate))
        .map((clip) => offerOf(clip, run, visible)),
      dubs: await Promise.all(visible.map((dub) => this.viewOf(dub, clips))),
    };
  }

  /**
   * Dub a clip. The same languages asked for again while a dub of them is
   * live or made answer with that dub (`created: false`); any other overlap
   * is refused, naming the languages.
   */
  async create(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    input: CreateDubInput,
  ): Promise<{ readonly dub: DubView; readonly created: boolean }> {
    await this.assertFlow(workspaceId);
    await this.assertDubbing(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") throw runStopped();
    const clip = await this.requireClip(run, clipId);
    if (input.consent !== true) {
      throw new AppException(
        DUB_ERRORS.consentRequired,
        "Confirm that you have the right to use this speaker's voice, and consent to it being cloned.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const facts = await this.dubbableFacts(run, clip);
    const languages = [...input.languages];
    if (languages.includes(facts.sourceLanguage)) {
      throw new AppException(
        DUB_ERRORS.sameLanguage,
        `This clip is already in ${dubLanguageOption(facts.sourceLanguage).name}.`,
        HttpStatus.BAD_REQUEST,
        { language: facts.sourceLanguage },
      );
    }

    // The same request twice (a double click, a retried request) is one dub.
    const existing = await this.prisma.clipDub.findMany({
      where: { clipId: clip.id, status: { notIn: ["failed", "cancelled"] } },
    });
    const wanted = [...languages].sort().join(",");
    const same = existing.find((dub) => [...dub.languages].sort().join(",") === wanted);
    if (same !== undefined) return { dub: await this.viewById(same.id), created: false };
    const taken = languages.filter((code) => existing.some((dub) => dub.languages.includes(code)));
    if (taken.length > 0) {
      throw new AppException(
        DUB_ERRORS.languageTaken,
        `This clip is already dubbed, or being dubbed, into ${taken
          .map((code) => dubLanguageOption(code).name)
          .join(", ")}.`,
        HttpStatus.CONFLICT,
        { languages: taken },
      );
    }

    const costTenths = dubCostTenths(facts.durationMs, languages.length);
    await this.assertAffordable(workspaceId, costTenths);
    await this.assertRoomForAnother(workspaceId);

    // The rupees last, so a refusal above never touches the day's tally.
    const paise = dubVendorPaise(facts.durationMs, languages.length);
    const reserved = await this.reserveBudget(paise);

    const now = new Date();
    let dub: ClipDub;
    try {
      dub = await this.prisma.clipDub.create({
        data: {
          id: ulid(),
          runId: run.id,
          clipId: clip.id,
          workspaceId: run.workspaceId,
          sourceLanguage: facts.sourceLanguage,
          languages,
          status: "waiting",
          durationMs: facts.durationMs,
          costTenths,
          speakers: facts.speakers,
          budgetDay: reserved.day,
          budgetPaise: paise,
          consentBy: userId,
          consentAt: now,
          createdBy: userId,
        },
      });
    } catch (error) {
      await this.budget.release(reserved.day, paise);
      throw error;
    }

    try {
      await this.start(dub);
    } catch (error) {
      // Refused before anything was spent (no credits, a queue that is down):
      // nothing is left behind, and the rupees go back.
      await this.prisma.clipDub.deleteMany({ where: { id: dub.id, jobId: null } });
      await this.budget.release(reserved.day, paise);
      throw translateRefusal(error);
    }

    await this.audit.record({
      action: "repurpose.dub.requested",
      resource: "clip_dub",
      resourceId: dub.id,
      actorId: userId,
      workspaceId,
      data: {
        runId: run.id,
        clipId: clip.id,
        sourceLanguage: facts.sourceLanguage,
        languages,
        durationMs: facts.durationMs,
        costTenths,
        vendorPaise: paise,
        // Voice cloning: the person's word, recorded with the sentence they gave it to.
        consent: {
          by: userId,
          at: now.toISOString(),
          statement: DUB_CONSENT_STATEMENT,
          version: DUB_CONSENT_VERSION,
        },
      },
    });
    return { dub: await this.viewById(dub.id), created: true };
  }

  /**
   * Dub again after a failure. A vendor job that did not definitively fail is
   * resumed - collected if it finished, polled if it is still going - and
   * neither the budget nor the vendor is charged again for it; otherwise a new
   * vendor job is started, and the day's budget is charged for it.
   */
  async retry(workspaceId: string, userId: string, runId: string, dubId: string): Promise<DubView> {
    await this.assertFlow(workspaceId);
    await this.assertDubbing(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") throw runStopped();
    const dub = await this.requireDub(run, dubId);
    if (!canRetry(dub)) {
      throw new AppException(
        DUB_ERRORS.notRetryable,
        dub.status === "failed"
          ? "This dub was refused for a reason trying again would not change."
          : "This dub is not one that failed.",
        HttpStatus.CONFLICT,
        { status: dub.status, failureCode: dub.failureCode },
      );
    }
    const clip = await this.requireClip(run, dub.clipId);
    const facts = await this.dubbableFacts(run, clip);
    await this.assertAffordable(workspaceId, dub.costTenths);
    await this.assertRoomForAnother(workspaceId);

    // A vendor job that definitively failed is never resumed: forgotten here,
    // so a retry that waits for the lane cannot pick it up again later.
    const resumes = dub.vendorJobId !== null && !DEFINITIVE_FAILURES.has(dub.failureCode ?? "");
    let budget: { readonly day: string; readonly paise: number } | null = null;
    if (!resumes) {
      const paise = dubVendorPaise(facts.durationMs, dub.languages.length);
      budget = { day: (await this.reserveBudget(paise)).day, paise };
    }

    const { count } = await this.prisma.clipDub.updateMany({
      where: { id: dub.id, status: "failed" },
      data: {
        status: "waiting",
        failureCode: null,
        failureMessage: null,
        ...(resumes ? {} : { vendorJobId: null }),
        ...(budget === null ? {} : { budgetDay: budget.day, budgetPaise: budget.paise }),
      },
    });
    if (count === 0) {
      if (budget !== null) await this.budget.release(budget.day, budget.paise);
      throw new AppException(
        DUB_ERRORS.notRetryable,
        "This dub is already being tried again.",
        HttpStatus.CONFLICT,
      );
    }
    try {
      await this.start({
        ...dub,
        status: "waiting",
        vendorJobId: resumes ? dub.vendorJobId : null,
      });
    } catch (error) {
      await this.fail(dub.id, error instanceof AppException ? error.code : DUB_ERRORS.failed, null);
      throw translateRefusal(error);
    }
    await this.audit.record({
      action: "repurpose.dub.retried",
      resource: "clip_dub",
      resourceId: dub.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, fromFailure: dub.failureCode, resumesVendorJob: resumes },
    });
    return this.viewById(dub.id);
  }

  /**
   * Stop a dub that is waiting or with the vendor: its job is cancelled (the
   * credits come back), and so is the vendor's job, by a cancel job worker-ai
   * runs. A dub whose vendor job never started gives its rupees back too.
   */
  async cancel(
    workspaceId: string,
    userId: string,
    runId: string,
    dubId: string,
  ): Promise<DubView> {
    await this.assertFlow(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const dub = await this.requireDub(run, dubId);
    if (dub.status !== "waiting" && dub.status !== "dubbing") {
      throw new AppException(
        DUB_ERRORS.notCancellable,
        dub.status === "making" || dub.status === "ready"
          ? "The dub is already made; only its videos are still being finished."
          : "This dub has already ended.",
        HttpStatus.CONFLICT,
        { status: dub.status },
      );
    }
    const { count } = await this.prisma.clipDub.updateMany({
      where: { id: dub.id, status: { in: ["waiting", "dubbing"] } },
      data: { status: "cancelled", cancelledAt: new Date(), failureCode: DUB_ERRORS.cancelled },
    });
    if (count === 0) {
      throw new AppException(
        DUB_ERRORS.notCancellable,
        "This dub finished its part with the vendor a moment ago.",
        HttpStatus.CONFLICT,
      );
    }

    const job =
      dub.jobId === null ? null : await this.prisma.job.findUnique({ where: { id: dub.jobId } });
    if (job !== null && (job.status === "queued" || job.status === "running")) {
      await this.jobs.cancel(job.id, run.workspaceId).catch((error: unknown) => {
        // Finished a moment ago: nothing left to stop.
        if (!(error instanceof AppException && error.code === JOB_ERROR_CODES.invalidState)) {
          throw error;
        }
      });
    }
    const vendor = vendorJobOf(job?.checkpoint) ?? {
      vendorJobId: dub.vendorJobId,
      started: dub.vendorJobId !== null,
    };
    if (vendor.vendorJobId !== null) await this.stopVendorJob(dub, vendor.vendorJobId);
    if (!vendor.started) await this.giveBudgetBack(dub);

    await this.audit.record({
      action: "repurpose.dub.cancelled",
      resource: "clip_dub",
      resourceId: dub.id,
      actorId: userId,
      workspaceId,
      data: {
        runId: run.id,
        fromStatus: dub.status,
        vendorJobId: vendor.vendorJobId,
        vendorStarted: vendor.started,
      },
    });
    return this.viewById(dub.id);
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * Move every dub of a run on: a waiting one is offered the lane, one whose
   * vendor job ended without its completion landing is settled from the job,
   * and a made one gets its shapes laid, captioned and settled. Called from the
   * run's reconcile (every read of its clips and the watchdog) and from the
   * dub list. Never throws for one dub.
   */
  async reconcileRun(runId: string): Promise<void> {
    this.markReconciled(runId);
    const dubs = await this.prisma.clipDub.findMany({
      where: { runId, status: { in: [...LIVE_DUB_STATUSES, "ready"] } },
      orderBy: { createdAt: "asc" },
    });
    for (const dub of dubs) {
      try {
        if ((await this.reconcileDub(dub)) === "lane_full") break;
      } catch (error) {
        this.logger.warn({ dubId: dub.id, err: error }, "could not move a dub on this pass");
      }
    }
  }

  /**
   * The watchdog's pass (`RepurposeReconciler`): every run with a dub still in
   * motion, whatever state the run is in. Never throws.
   */
  async sweep(): Promise<void> {
    try {
      const live = await this.prisma.clipDub.findMany({
        where: { status: { in: [...LIVE_DUB_STATUSES] } },
        select: { runId: true },
        orderBy: { createdAt: "asc" },
        take: DUB_SWEEP_BATCH,
      });
      for (const runId of new Set(live.map((row) => row.runId))) {
        await this.reconcileRun(runId).catch((error: unknown) => {
          this.logger.warn({ runId, err: error }, "could not reconcile a run's dubs");
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, "dub sweep failed; the next one retries");
    }
  }

  /**
   * One dub's reconcile, right after something about it landed (a completion),
   * without making the caller wait. Calls for a dub already being reconciled
   * fold into one more pass. Never rejects.
   */
  reconcileDubSoon(dubId: string): Promise<void> {
    const current = this.reconciling.get(dubId);
    if (current !== undefined) {
      current.again = true;
      return current.done;
    }
    const entry = { again: false, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        do {
          entry.again = false;
          const dub = await this.prisma.clipDub.findUnique({ where: { id: dubId } });
          if (dub !== null) await this.reconcileDub(dub);
        } while (entry.again);
      } catch (error) {
        this.logger.warn({ dubId, err: error }, "could not reconcile a dub after its completion");
      } finally {
        this.reconciling.delete(dubId);
      }
    })();
    this.reconciling.set(dubId, entry);
    return entry.done;
  }

  private async reconcileDub(dub: ClipDub): Promise<"lane_full" | "done"> {
    switch (dub.status) {
      case "waiting": {
        try {
          return (await this.start(dub)) === "waiting" ? "lane_full" : "done";
        } catch (error) {
          const code = error instanceof AppException ? error.code : DUB_ERRORS.failed;
          this.logger.warn({ dubId: dub.id, code, err: error }, "a waiting dub could not start");
          await this.fail(dub.id, translateRefusal(error).code, null);
          // A resumed dub's vendor job ran: its rupees stay counted.
          if (dub.vendorJobId === null) await this.giveBudgetBack(dub);
          return "done";
        }
      }
      case "dubbing":
        await this.settleLost(dub);
        return "done";
      case "making":
      case "ready":
        return this.makeShapes(dub);
      default:
        return "done";
    }
  }

  // -------------------------------------------------------------------------
  // The vendor's part
  // -------------------------------------------------------------------------

  /**
   * Ask for the dub's `ai.dub` job: `dubbing` when it is queued, `waiting` when
   * the plan's lane is full (the dub stays `waiting`, and the reconcile asks
   * again). Anything else is thrown.
   */
  private async start(dub: ClipDub): Promise<"dubbing" | "waiting"> {
    const run = await this.prisma.repurposeRun.findUniqueOrThrow({ where: { id: dub.runId } });
    const clip = await this.prisma.repurposeClip.findUniqueOrThrow({
      where: { id: dub.clipId },
      include: CLIP_SHAPES_INCLUDE,
    });
    const source = clip.mezzanineKey;
    if (source === null || !CLIP_VIDEO_KEY_PATTERN.test(source)) throw clipNotReady();
    const attempt = dub.attempts + 1;
    const resume = resumableVendorJob(dub);
    const payload = AiDubPayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      action: "dub",
      runId: run.id,
      clipId: clip.id,
      dubId: dub.id,
      source: { key: source, contentType: "video/mp4" },
      durationMs: dub.durationMs,
      sourceLanguage: dub.sourceLanguage,
      targetLanguages: dub.languages,
      speakers: dub.speakers,
      destinationPrefix: this.folderOf(run, dub),
      ...(resume === null ? {} : { resumeVendorJobId: resume }),
    });
    try {
      const { job } = await this.jobs.enqueue({
        type: "ai.dub",
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        params: payload,
        jobKey: aiDubJobKey(dub.id, attempt),
        worstCaseTenths: dub.costTenths,
        reason: `ai.dub · ${String(dub.languages.length)} languages · ${dub.id}`,
      });
      await this.prisma.clipDub.updateMany({
        where: { id: dub.id, status: "waiting" },
        data: { status: "dubbing", jobId: job.id, attempts: attempt },
      });
      this.logger.log(
        { dubId: dub.id, jobId: job.id, languages: dub.languages, resumes: resume !== null },
        "asked for a dub",
      );
      return "dubbing";
    } catch (error) {
      if (isLaneFull(error)) {
        this.logger.log(
          { dubId: dub.id },
          "plan lane is full; the dub waits for the next reconcile",
        );
        return "waiting";
      }
      throw error;
    }
  }

  /**
   * The vendor's files are in: record them and move on to the shapes, or fail
   * the dub when none came back. Called by the `ai.dub` completion handler;
   * conditional on the dub still dubbing with this job, so a replay changes
   * nothing. @returns the tenths the job settles: the languages delivered.
   */
  async applyDubbed(
    dubId: string,
    jobId: string,
    result: { readonly vendorJobId: string; readonly tracks: readonly DubTrack[] },
  ): Promise<number> {
    const dub = await this.prisma.clipDub.findUnique({ where: { id: dubId } });
    if (dub === null) return 0;
    const ready = result.tracks.filter((track) => track.status === "ready");
    const { count } = await this.prisma.clipDub.updateMany({
      where: { id: dub.id, jobId, status: "dubbing" },
      data:
        ready.length > 0
          ? {
              status: "making",
              tracks: result.tracks as unknown as Prisma.InputJsonValue,
              vendorJobId: result.vendorJobId,
              failureCode: null,
              failureMessage: null,
            }
          : {
              status: "failed",
              tracks: result.tracks as unknown as Prisma.InputJsonValue,
              vendorJobId: result.vendorJobId,
              failureCode: DUB_ERRORS.vendorFailed,
              failureMessage: "The dubbing service finished without dubbed audio for any language.",
              completedAt: new Date(),
            },
    });
    if (count === 0) return 0;
    void this.reconcileDubSoon(dub.id);
    return dubCostTenths(dub.durationMs, ready.length);
  }

  /**
   * The dub's job failed (worker-reported, cancelled, stalled): the dub fails
   * with its code, unless it was cancelled on purpose. Its rupees go back when
   * the vendor's job never started. Idempotent.
   */
  async applyJobFailed(
    dubId: string,
    jobId: string,
    error: { readonly code?: string; readonly message?: string } | null,
    checkpoint: Prisma.JsonValue | null,
  ): Promise<void> {
    const dub = await this.prisma.clipDub.findUnique({ where: { id: dubId } });
    if (dub === null || dub.jobId !== jobId || dub.status !== "dubbing") return;
    const vendor = vendorJobOf(checkpoint);
    const code = failureCodeOf(error?.code);
    const message =
      VENDOR_WORDS.has(code) && typeof error?.message === "string" && error.message.trim() !== ""
        ? error.message.slice(0, 300)
        : null;
    const { count } = await this.prisma.clipDub.updateMany({
      where: { id: dub.id, jobId, status: "dubbing" },
      data: {
        status: "failed",
        failureCode: code,
        failureMessage: message,
        completedAt: new Date(),
        // Only a started vendor job is one worth resuming (or paying for).
        ...(vendor?.started === true ? { vendorJobId: vendor.vendorJobId } : {}),
      },
    });
    if (count > 0 && vendor?.started !== true && dub.vendorJobId === null) {
      await this.giveBudgetBack(dub);
    }
  }

  /**
   * A dub still `dubbing` whose job has ended without its handler's write
   * reaching the dub (a callback lost to a restart, a job the lease reaper
   * settled): read from the job.
   */
  private async settleLost(dub: ClipDub): Promise<void> {
    if (dub.jobId === null) return;
    const job = await this.prisma.job.findUnique({ where: { id: dub.jobId } });
    if (job === null || job.status === "queued" || job.status === "running") return;
    if (job.status === "succeeded") {
      const tracks = tracksOf(job.result);
      const vendorJobId = (job.result as { vendorJobId?: unknown } | null)?.vendorJobId;
      if (tracks !== null && typeof vendorJobId === "string") {
        await this.applyDubbed(dub.id, job.id, { vendorJobId, tracks });
        return;
      }
    }
    await this.applyJobFailed(
      dub.id,
      job.id,
      (job.error as { code?: string; message?: string } | null) ?? null,
      job.checkpoint,
    );
  }

  /** Ask worker-ai to stop the vendor's job. Best effort: the live worker stops it too. */
  private async stopVendorJob(dub: ClipDub, vendorJobId: string): Promise<void> {
    try {
      await this.jobs.enqueue({
        type: "ai.dub",
        workspaceId: dub.workspaceId,
        params: AiDubPayloadSchema.parse({
          schemaVersion: REPURPOSE_SCHEMA_VERSION,
          action: "cancel",
          dubId: dub.id,
          vendorJobId,
        }),
        jobKey: aiDubCancelJobKey(dub.id, vendorJobId),
        worstCaseTenths: 0,
        reason: `ai.dub cancel · ${dub.id}`,
        // A cancel must never wait behind the lane it is freeing.
        skipAdmission: true,
      });
    } catch (error) {
      this.logger.warn(
        { dubId: dub.id, vendorJobId, err: error },
        "could not ask for the vendor's job to be cancelled",
      );
    }
  }

  // -------------------------------------------------------------------------
  // Shapes: laid, captioned, settled
  // -------------------------------------------------------------------------

  private async makeShapes(stored: ClipDub): Promise<"lane_full" | "done"> {
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: stored.runId } });
    const clip = await this.prisma.repurposeClip.findUnique({
      where: { id: stored.clipId },
      include: CLIP_SHAPES_INCLUDE,
    });
    if (run === null || clip === null || isRemoved(clip.candidate)) return "done";
    const tracks = (tracksOf(stored.tracks) ?? []).filter((track) => track.status === "ready");
    const shapes = shapesOf(clip);

    let laneFull = false;
    // 1. Lay each language under each shape that has no dubbed picture yet.
    const dub = await this.fresh(stored.id);
    const have = new Set(dub.variants.map((row) => `${row.language}:${row.aspect}`));
    for (const track of tracks) {
      if (laneFull) break;
      for (const shape of shapes) {
        if (have.has(`${track.language}:${shape.aspect}`)) continue;
        if ((await this.enqueueMux(run, dub, track, shape)) === "lane_full") {
          laneFull = true;
          break;
        }
      }
    }

    // 2. Each dubbed shape's captioned video.
    for (const row of dub.variants) {
      if ((await this.caption(run, dub, row)) === "lane_full") {
        laneFull = true;
        break;
      }
    }

    // 3. Made, once every language's every shape has settled; again, when a
    //    shape the clip gained since (Autopilot's other formats) is owed.
    const settled = await this.allSettled(dub.id, tracks, shapes);
    const next: $Enums.DubStatus = settled ? "ready" : "making";
    if (next !== dub.status) {
      await this.prisma.clipDub.updateMany({
        where: { id: dub.id, status: dub.status },
        data: { status: next, completedAt: next === "ready" ? new Date() : null },
      });
    }
    return laneFull ? "lane_full" : "done";
  }

  /** One language under one shape (`media.dub`), unless it is under way or given up. */
  private async enqueueMux(
    run: RepurposeRun,
    dub: DubWithShapes,
    track: DubTrack,
    shape: ShapePicture,
  ): Promise<"asked" | "skipped" | "lane_full"> {
    if (track.audio === undefined) return "skipped";
    const jobKey = mediaDubJobKey(dub.id, track.language, shape.shape);
    const jobs = await this.prisma.job.findMany({
      where: { workspaceId: run.workspaceId, type: "media.dub", jobKey },
      select: { status: true },
    });
    if (jobs.some((job) => job.status === "queued" || job.status === "running")) return "skipped";
    // Succeeded: its completion is landing, and files the shape.
    if (jobs.some((job) => job.status === "succeeded")) return "skipped";
    if (jobs.filter((job) => job.status !== "succeeded").length >= DUB_MUX_ATTEMPTS) {
      return "skipped";
    }
    const bed = dubOriginalBedDb();
    const payload = MediaDubPayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: run.id,
      clipId: dub.clipId,
      dubId: dub.id,
      language: track.language,
      shape: shape.shape,
      video: { key: shape.key, durationMs: shape.durationMs },
      audio: { key: track.audio.key },
      destination: {
        bucket: this.derived.kind,
        key: dubVideoKey(this.folderOf(run, dub), track.language, shape.shape),
      },
      ...(bed === undefined ? {} : { originalBedDb: bed }),
    });
    try {
      await this.jobs.enqueue({
        type: "media.dub",
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        params: payload,
        jobKey,
        worstCaseTenths: 0,
        reason: `media.dub ${track.language} ${shape.shape} · ${dub.id}`,
      });
      this.logger.log(
        { dubId: dub.id, language: track.language, shape: shape.shape },
        "asked for a dubbed shape",
      );
      return "asked";
    } catch (error) {
      if (isLaneFull(error)) return "lane_full";
      this.logger.warn(
        { dubId: dub.id, language: track.language, shape: shape.shape, err: error },
        "could not ask for a dubbed shape; the next pass tries again",
      );
      return "skipped";
    }
  }

  /**
   * One dubbed shape's captioned video, as `captionClips` makes a clip's: once
   * its picture is ready, its document exists and its face track has settled;
   * again a minute after its captions are edited; given up after
   * {@link DUB_RENDER_ATTEMPTS} failed renders.
   */
  private async caption(
    run: RepurposeRun,
    dub: DubWithShapes,
    row: DubShapeRow,
  ): Promise<"lane_full" | "done"> {
    const exports = this.exports;
    if (exports === undefined) return "done";
    const media = row.project.mediaAssets[0];
    const doc = row.project.edgDocument;
    if (media === undefined) return "done";
    if (media.status === "failed") {
      if (row.status !== "failed") await this.setShape(row.id, "failed");
      return "done";
    }
    if (media.status !== "ready" || doc === null) return "done";
    const fingerprint = `edg:${String(doc.revision)}`;
    const latest = row.latestExport;
    const current = row.editFingerprint === fingerprint;
    const now = Date.now();

    if (latest !== null && (latest.status === "rendering" || latest.status === "pending_browser")) {
      if (row.status !== "rendering") await this.setShape(row.id, "rendering");
      return "done";
    }
    if (latest !== null && latest.status === "succeeded" && current) {
      if (row.status !== "ready") await this.setShape(row.id, "ready");
      return "done";
    }
    if (latest !== null && latest.status === "failed" && current) {
      const failed = row.project.exports.filter((entry) => entry.status === "failed").length;
      if (failed >= DUB_RENDER_ATTEMPTS) {
        if (row.status !== "failed") await this.setShape(row.id, "failed");
        return "done";
      }
    }
    if (latest === null && row.status === "failed" && current) return "done"; // refused
    if (latest !== null && !current && now - doc.updatedAt.getTime() < DUB_CAPTIONED_QUIET_MS) {
      if (row.status !== "stale") await this.setShape(row.id, "stale");
      return "done";
    }
    // Captions keep off faces: wait for this picture's face track.
    if (media.facesKey === null && (await this.facesPending(media))) return "done";

    try {
      const requested = await exports.requestExport({
        projectId: row.projectId,
        workspaceId: run.workspaceId,
        userId: dub.createdBy ?? run.createdBy,
        kind: "video",
        outputKind: "video",
        ...RENDER_SIZE_OF_ASPECT[row.aspect],
        // A word's own text: the dub's words are in the language's own script.
        script: "roman",
        mode: "cloud",
        dropFillers: false,
        options: { watermarkPosition: "bottom-right", watermarkOpacity: 1 },
      });
      await this.prisma.clipDubVariant.update({
        where: { id: row.id },
        data: {
          latestExportId: requested.exportId,
          status: "rendering",
          editFingerprint: fingerprint,
        },
      });
      this.captionRequestErrors.delete(row.id);
      return "done";
    } catch (error) {
      if (isLaneFull(error)) return "lane_full";
      const tries = (this.captionRequestErrors.get(row.id) ?? 0) + 1;
      if (!isRefusal(error) && tries < DUB_RENDER_ATTEMPTS) {
        this.captionRequestErrors.set(row.id, tries);
        return "done";
      }
      this.captionRequestErrors.delete(row.id);
      this.logger.warn(
        { dubId: dub.id, projectId: row.projectId, err: error },
        "could not ask for a dubbed shape's captioned video; left until its captions change",
      );
      await this.prisma.clipDubVariant
        .update({ where: { id: row.id }, data: { status: "failed", editFingerprint: fingerprint } })
        .catch(() => undefined);
      return "done";
    }
  }

  /**
   * Every language that came back has every owed shape settled: made (its
   * captioned video exists), failed, or given up (its lays all failed).
   */
  private async allSettled(
    dubId: string,
    tracks: readonly DubTrack[],
    shapes: readonly ShapePicture[],
  ): Promise<boolean> {
    const dub = await this.fresh(dubId);
    for (const track of tracks) {
      for (const shape of shapes) {
        const row = dub.variants.find(
          (entry) => entry.language === track.language && entry.aspect === shape.aspect,
        );
        if (row !== undefined) {
          if (row.status === "failed") continue;
          if (row.status === "ready" && row.latestExport?.status === "succeeded") continue;
          if (this.exports === undefined && row.project.mediaAssets[0]?.status === "ready") {
            continue;
          }
          return false;
        }
        const failed = await this.prisma.job.count({
          where: {
            workspaceId: dub.workspaceId,
            type: "media.dub",
            jobKey: mediaDubJobKey(dub.id, track.language, shape.shape),
            status: { in: ["failed", "cancelled"] },
          },
        });
        if (failed < DUB_MUX_ATTEMPTS) return false;
      }
    }
    return true;
  }

  private async facesPending(media: {
    readonly id: string;
    readonly durationMs: number | null;
    readonly width: number | null;
    readonly uploadedAt: Date | null;
  }): Promise<boolean> {
    try {
      const job = await this.prisma.job.findFirst({
        where: { type: "ai.faces", jobKey: facesJobKey(media.id) },
        orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
        select: { status: true, queuedAt: true, startedAt: true, finishedAt: true },
      });
      return awaitingPictureFaces(
        job,
        media.width === null ? null : media.uploadedAt,
        media.durationMs,
      );
    } catch {
      return false;
    }
  }

  private async setShape(
    id: string,
    status: "rendering" | "ready" | "stale" | "failed",
  ): Promise<void> {
    await this.prisma.clipDubVariant.update({ where: { id }, data: { status } });
  }

  // -------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------

  private async viewById(dubId: string): Promise<DubView> {
    const dub = await this.fresh(dubId);
    const clips = await this.clipsOf(dub.runId);
    return this.viewOf(dub, clips);
  }

  private async viewOf(dub: DubWithShapes, clips: readonly ClipWithShapes[]): Promise<DubView> {
    const clip = clips.find((entry) => entry.id === dub.clipId);
    const shapes = clip === undefined ? [] : shapesOf(clip);
    const tracks = tracksOf(dub.tracks) ?? [];
    const title = clip?.title ?? "clip";

    let progress: number | null = null;
    let step: string | null = null;
    if (dub.status === "dubbing" && dub.jobId !== null) {
      const [job, events] = await Promise.all([
        this.prisma.job.findUnique({
          where: { id: dub.jobId },
          select: { status: true, progress: true },
        }),
        this.prisma.jobEvent.findMany({
          where: { jobId: dub.jobId, level: "debug" },
          orderBy: { at: "desc" },
          take: 1,
          select: { message: true },
        }),
      ]);
      if (job?.status === "running") progress = job.progress;
      const message = events[0]?.message;
      if (typeof message === "string" && !/^progress \d+%$/.test(message)) step = message;
    }

    const languages: DubLanguageView[] = [];
    for (const code of dub.languages) {
      if (!isDubLanguage(code)) continue;
      const option = dubLanguageOption(code);
      const track = tracks.find((entry) => entry.language === code);
      const formats: DubFormatView[] = [];
      if (dub.status === "making" || dub.status === "ready") {
        for (const shape of shapes) {
          const row = dub.variants.find(
            (entry) => entry.language === code && entry.aspect === shape.aspect,
          );
          formats.push(await this.formatOf(row, shape, title, option, dub));
        }
      }
      languages.push({
        ...option,
        status: languageStatus(dub, track, formats),
        reason:
          track?.status === "failed"
            ? (track.reason ?? "The dubbing service did not dub this language.")
            : dub.status === "failed"
              ? dub.failureMessage
              : null,
        formats,
      });
    }

    return {
      id: dub.id,
      runId: dub.runId,
      clipId: dub.clipId,
      status: dub.status,
      failureCode: dub.status === "failed" ? dub.failureCode : null,
      failureMessage: dub.status === "failed" ? dub.failureMessage : null,
      sourceLanguage: isDubLanguage(dub.sourceLanguage)
        ? dubLanguageOption(dub.sourceLanguage)
        : { code: "en-IN", name: dub.sourceLanguage },
      languages,
      durationMs: dub.durationMs,
      costTenths: dub.costTenths,
      progress,
      step,
      canRetry: canRetry(dub),
      canCancel: dub.status === "waiting" || dub.status === "dubbing",
      createdAt: dub.createdAt.toISOString(),
      updatedAt: dub.updatedAt.toISOString(),
    };
  }

  private async formatOf(
    row: DubShapeRow | undefined,
    shape: ShapePicture,
    title: string,
    language: DubLanguageOption,
    dub: DubWithShapes,
  ): Promise<DubFormatView> {
    if (row === undefined) {
      const failed = await this.prisma.job.count({
        where: {
          workspaceId: dub.workspaceId,
          type: "media.dub",
          jobKey: mediaDubJobKey(dub.id, language.code, shape.shape),
          status: { in: ["failed", "cancelled"] },
        },
      });
      return {
        shape: shape.shape,
        status: failed >= DUB_MUX_ATTEMPTS ? "failed" : "preparing",
        projectId: null,
        captioned: null,
        cleanUrl: null,
      };
    }
    const name = `${title.slice(0, 60) || "clip"} ${shape.shape.replace(":", "x")} ${language.name}`;
    const media = row.project.mediaAssets[0];
    const cleanUrl =
      media !== undefined && media.status === "ready" && media.storageKey !== ""
        ? await this.derived
            .presignGet(media.storageKey, DUB_URL_TTL_SECONDS, {
              downloadFilename: `${name} no captions.mp4`,
            })
            .catch(() => null)
        : null;
    const done = row.project.exports.find(
      (entry) => entry.status === "succeeded" && entry.storageKey !== null,
    );
    let captioned: DubCaptionedView | null = null;
    if (row.latestExportId !== null || row.status === "failed") {
      const status: DubCaptionedView["status"] =
        row.status === "ready" || row.status === "stale" || row.status === "failed"
          ? row.status
          : "rendering";
      let playUrl: string | null = null;
      let downloadUrl: string | null = null;
      if (done?.storageKey !== undefined && done.storageKey !== null) {
        const key = done.storageKey;
        [playUrl, downloadUrl] = await Promise.all([
          this.derived.presignGet(key, DUB_URL_TTL_SECONDS).catch(() => null),
          this.derived
            .presignGet(key, DUB_URL_TTL_SECONDS, { downloadFilename: `${name}.mp4` })
            .catch(() => null),
        ]);
      }
      captioned = { status, playUrl, downloadUrl };
    }
    const status: DubFormatView["status"] =
      row.status === "failed"
        ? "failed"
        : captioned === null
          ? "preparing"
          : captioned.status === "ready"
            ? "ready"
            : captioned.status;
    return { shape: shape.shape, status, projectId: row.projectId, captioned, cleanUrl };
  }

  // -------------------------------------------------------------------------
  // Checks
  // -------------------------------------------------------------------------

  /**
   * What a dub of this clip is made from: its clean 9:16 picture, ready, and
   * a language the vendor dubs from. Everything that can refuse, refuses here,
   * before a row, a hold or a rupee exists.
   */
  private async dubbableFacts(
    run: RepurposeRun,
    clip: ClipWithShapes,
  ): Promise<{
    readonly sourceLanguage: DubLanguage;
    readonly durationMs: number;
    readonly speakers: number;
  }> {
    const offer = offerOf(clip, run, []);
    if (!offer.ready || offer.durationMs === null) throw clipNotReady();
    if (offer.sourceLanguage === null) {
      throw new AppException(
        DUB_ERRORS.sourceUnsupported,
        "Dubbing needs the clip's spoken language to be English or an Indian language Sarvam dubs.",
        HttpStatus.CONFLICT,
      );
    }
    if (offer.durationMs > DUB_LIMITS.maxDurationMs) {
      throw new AppException(
        DUB_ERRORS.tooLong,
        "This clip is longer than a dub can be.",
        HttpStatus.BAD_REQUEST,
        { durationMs: offer.durationMs, maxDurationMs: DUB_LIMITS.maxDurationMs },
      );
    }
    return {
      sourceLanguage: offer.sourceLanguage.code,
      durationMs: offer.durationMs,
      speakers: await this.speakersOf(clip),
    };
  }

  /**
   * How many people speak, when the transcript knows (two or more diarised
   * speakers), or two for a picture cut stacked; otherwise the vendor counts
   * (-1). One diarised speaker is not trusted: a transcript that was never
   * diarised says one for everyone.
   */
  private async speakersOf(clip: ClipWithShapes): Promise<number> {
    const vertical = clip.variants.find((variant) => variant.aspect === "r9x16");
    const transcript = vertical?.project.transcripts[0];
    let distinct = 0;
    if (transcript !== undefined) {
      try {
        const chunks = await newestChunkRows(this.prisma, transcript.id);
        const speakers = new Set(
          chunks
            .flatMap((chunk) => (chunk.words as unknown as Word[] | null) ?? [])
            .map((word) => word.sp)
            .filter((sp): sp is string => typeof sp === "string" && sp !== ""),
        );
        distinct = speakers.size;
      } catch (error) {
        this.logger.debug({ clipId: clip.id, err: error }, "could not count the clip's speakers");
      }
    }
    if (distinct >= 2) return Math.min(DUB_LIMITS.maxSpeakers, distinct);
    if (vertical?.layout === "stacked") return 2;
    return -1;
  }

  /** The balance covers the dub, and the plan may hold that much at once. */
  private async assertAffordable(workspaceId: string, costTenths: number): Promise<void> {
    const limits = planLimits(await resolveWorkspacePlan(this.prisma, workspaceId));
    if (costTenths > limits.enqueuedCapTenths) {
      throw new AppException(
        DUB_ERRORS.planLimit,
        `This dub costs ${formatCredits(costTenths)} credits, more than your plan can hold for work at once (${formatCredits(limits.enqueuedCapTenths)}). Dub into fewer languages at a time.`,
        HttpStatus.PAYMENT_REQUIRED,
        { costTenths, enqueuedCapTenths: limits.enqueuedCapTenths, plan: limits.plan },
      );
    }
    const account = await this.prisma.creditAccount.findUnique({
      where: { workspaceId },
      select: { balanceTenths: true },
    });
    const balance = account?.balanceTenths ?? 0;
    if (balance < costTenths) {
      throw new AppException(
        DUB_ERRORS.noCredits,
        `This dub costs ${formatCredits(costTenths)} credits and you have ${formatCredits(balance)}.`,
        HttpStatus.PAYMENT_REQUIRED,
        { costTenths, balanceTenths: balance, shortfallTenths: costTenths - balance },
      );
    }
  }

  private async assertRoomForAnother(workspaceId: string): Promise<void> {
    const live = await this.prisma.clipDub.count({
      where: { workspaceId, status: { in: ["waiting", "dubbing"] } },
    });
    if (live >= MAX_LIVE_DUBS_PER_WORKSPACE) {
      throw new AppException(
        DUB_ERRORS.tooMany,
        `${String(live)} dubs are already being made. Try again when one has finished.`,
        HttpStatus.TOO_MANY_REQUESTS,
        { live, limit: MAX_LIVE_DUBS_PER_WORKSPACE, retryAfterSeconds: 60 },
      );
    }
  }

  private async reserveBudget(paise: number): Promise<{ readonly day: string }> {
    const decision = await this.budget.reserve(paise);
    if (decision.ok) return { day: decision.day };
    throw new AppException(
      DUB_ERRORS.budgetReached,
      "Dubbing has reached today's limit. Try again tomorrow (the day starts at 05:30 IST).",
      HttpStatus.TOO_MANY_REQUESTS,
      { day: decision.day, retryAfterSeconds: secondsToUtcMidnight() },
    );
  }

  /** Give a dub's rupees back to its day, once. */
  private async giveBudgetBack(dub: ClipDub): Promise<void> {
    if (dub.budgetDay === null || dub.budgetPaise <= 0) return;
    const { count } = await this.prisma.clipDub.updateMany({
      where: { id: dub.id, budgetPaise: dub.budgetPaise },
      data: { budgetPaise: 0 },
    });
    if (count > 0) await this.budget.release(dub.budgetDay, dub.budgetPaise);
  }

  private async fail(dubId: string, code: string, message: string | null): Promise<void> {
    await this.prisma.clipDub
      .updateMany({
        where: { id: dubId, status: { in: ["waiting", "dubbing"] } },
        data: {
          status: "failed",
          failureCode: code,
          failureMessage: message,
          completedAt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  private async fresh(dubId: string): Promise<DubWithShapes> {
    return this.prisma.clipDub.findUniqueOrThrow({ where: { id: dubId }, include: DUB_INCLUDE });
  }

  private async clipsOf(runId: string): Promise<ClipWithShapes[]> {
    return this.prisma.repurposeClip.findMany({
      where: { runId },
      include: CLIP_SHAPES_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
  }

  private folderOf(run: RepurposeRun, dub: { readonly id: string }): string {
    return dubFolder({
      workspaceId: run.workspaceId,
      sourceProjectId: run.sourceProjectId,
      runId: run.id,
      dubId: dub.id,
    });
  }

  private async requireClip(run: RepurposeRun, clipId: string): Promise<ClipWithShapes> {
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId: run.id },
      include: CLIP_SHAPES_INCLUDE,
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
        DUB_ERRORS.clipRemoved,
        "This moment was removed. Bring it back before dubbing its clip.",
        HttpStatus.CONFLICT,
      );
    }
    return clip;
  }

  private async requireDub(run: RepurposeRun, dubId: string): Promise<ClipDub> {
    const dub = await this.prisma.clipDub.findFirst({ where: { id: dubId, runId: run.id } });
    if (dub === null) {
      throw new AppException(
        DUB_ERRORS.notFound,
        "We could not find that dub.",
        HttpStatus.NOT_FOUND,
      );
    }
    return dub;
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

  /** The repurpose surface itself: 404 while `repurpose_flow` is off, as every clips route. */
  private async assertFlow(workspaceId: string): Promise<void> {
    if (await this.flagOn(workspaceId, REPURPOSE_FLAGS.flow)) return;
    throw new AppException(
      REPURPOSE_ERRORS.disabled,
      "This feature is not available yet.",
      HttpStatus.NOT_FOUND,
    );
  }

  private async assertDubbing(workspaceId: string): Promise<void> {
    if (await this.dubbingEnabled(workspaceId)) return;
    throw new AppException(
      DUB_ERRORS.notEnabled,
      "Dubbing is not switched on for this workspace.",
      HttpStatus.FORBIDDEN,
    );
  }

  private async dubbingEnabled(workspaceId: string): Promise<boolean> {
    return this.flagOn(workspaceId, DUB_FLAG);
  }

  /** An explicit value in `FEATURE_FLAGS_JSON` wins; otherwise the workspace's entitlement. */
  private async flagOn(workspaceId: string, flag: string): Promise<boolean> {
    // eslint-disable-next-line security/detect-object-injection -- a module constant, not input
    const override = this.env.FEATURE_FLAGS_JSON[flag];
    if (typeof override === "boolean") return override;
    const flags = (await this.entitlements.forWorkspace(workspaceId)).entitlements.flags as
      Record<string, boolean> | undefined;
    // eslint-disable-next-line security/detect-object-injection -- a module constant, not input
    return flags?.[flag] === true;
  }

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
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** One shape of a clip whose clean picture is ready to have a dub laid under it. */
interface ShapePicture {
  readonly shape: VideoShape;
  readonly aspect: $Enums.Aspect;
  readonly key: string;
  readonly durationMs: number;
}

/** The clip's shapes with a ready clean picture at a key a dub may read, in shape order. */
function shapesOf(clip: ClipWithShapes): ShapePicture[] {
  const shapes: ShapePicture[] = [];
  for (const shape of VIDEO_SHAPES) {
    const variant = clip.variants.find((row) => SHAPE_OF_ASPECT[row.aspect] === shape);
    const media = variant?.project.mediaAssets[0];
    if (
      variant === undefined ||
      media === undefined ||
      media.status !== "ready" ||
      media.durationMs === null ||
      media.durationMs <= 0 ||
      !CLIP_VIDEO_KEY_PATTERN.test(media.storageKey)
    ) {
      continue;
    }
    shapes.push({
      shape,
      aspect: variant.aspect,
      key: media.storageKey,
      durationMs: media.durationMs,
    });
  }
  return shapes;
}

/** What a clip offers the dialog ({@link DubOfferView}). */
function offerOf(clip: ClipWithShapes, run: RepurposeRun, dubs: readonly ClipDub[]): DubOfferView {
  const vertical = clip.variants.find((variant) => variant.aspect === "r9x16");
  const media = vertical?.project.mediaAssets[0];
  const ready =
    clip.mezzanineKey !== null &&
    CLIP_VIDEO_KEY_PATTERN.test(clip.mezzanineKey) &&
    media !== undefined &&
    media.status === "ready";
  const durationMs =
    media?.durationMs !== null && media?.durationMs !== undefined && media.durationMs > 0
      ? media.durationMs
      : clip.mezzanineDurationMs;
  // The clip's words are the source's: its transcript's language, else the run's choice.
  const configured = (run.config as { sourceLanguage?: unknown } | null)?.sourceLanguage;
  const tag =
    vertical?.project.transcripts[0]?.language ??
    (typeof configured === "string" ? configured : null);
  const code = vendorLanguageOf(tag);
  const taken = new Set<DubLanguage>();
  for (const dub of dubs) {
    if (dub.clipId !== clip.id || dub.status === "failed" || dub.status === "cancelled") continue;
    for (const language of dub.languages) if (isDubLanguage(language)) taken.add(language);
  }
  return {
    clipId: clip.id,
    ready,
    sourceLanguage: code === null ? null : dubLanguageOption(code),
    durationMs: durationMs ?? null,
    taken: [...taken],
  };
}

function languageStatus(
  dub: ClipDub,
  track: DubTrack | undefined,
  formats: readonly DubFormatView[],
): DubLanguageView["status"] {
  switch (dub.status) {
    case "waiting":
      return "queued";
    case "dubbing":
      return "dubbing";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      break;
  }
  if (track === undefined || track.status === "failed") return "failed";
  if (formats.length === 0) return dub.status === "ready" ? "failed" : "making";
  if (formats.some((format) => format.status === "preparing" || format.status === "rendering")) {
    return "making";
  }
  return formats.some((format) => format.status === "ready" || format.status === "stale")
    ? "ready"
    : "failed";
}

/** The vendor's files per language, as the dub row stores them; null when unreadable. */
function tracksOf(value: Prisma.JsonValue | null | undefined): DubTrack[] | null {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value)
    ? value
    : ((value as { tracks?: unknown }).tracks as unknown[] | undefined);
  if (!Array.isArray(list)) return null;
  const tracks: DubTrack[] = [];
  for (const entry of list) {
    const parsed = DubTrackSchema.safeParse(entry);
    if (parsed.success) tracks.push(parsed.data);
  }
  return tracks;
}

/** The vendor job a job's checkpoint names, and whether it was started. */
function vendorJobOf(
  checkpoint: Prisma.JsonValue | null | undefined,
): { readonly vendorJobId: string; readonly started: boolean } | null {
  const parsed = DubCheckpointSchema.safeParse(checkpoint);
  if (!parsed.success) return null;
  return {
    vendorJobId: parsed.data.vendorJobId,
    started: parsed.data.vendorPhase === "started",
  };
}

/**
 * The started vendor job an attempt resumes: the dub's own, which only a
 * started job ever sets, and which a retry after a definitive failure clears.
 */
function resumableVendorJob(dub: ClipDub): string | null {
  if (dub.vendorJobId === null) return null;
  if (dub.failureCode !== null && DEFINITIVE_FAILURES.has(dub.failureCode)) return null;
  return dub.vendorJobId;
}

function canRetry(dub: ClipDub): boolean {
  return dub.status === "failed" && !NOT_RETRYABLE_FAILURES.has(dub.failureCode ?? "");
}

/** A job error's code as a dub's failure: its own `dub/*`, or the job system's. */
function failureCodeOf(code: string | undefined): string {
  if (typeof code !== "string" || code === "") return DUB_ERRORS.failed;
  return code.slice(0, 128);
}

/** The plan's lane or its enqueued-credit cap: both clear as jobs finish. */
function isLaneFull(error: unknown): boolean {
  return (
    error instanceof AppException &&
    (error.code === JOB_ERROR_CODES.concurrencyCap || error.code === JOB_ERROR_CODES.enqueueCap)
  );
}

function isRefusal(error: unknown): boolean {
  return error instanceof AppException && error.httpStatus < 500;
}

/** A refusal from the credit ledger, in the dub's words. */
function translateRefusal(error: unknown): AppException {
  if (error instanceof AppException && error.code === "credits/insufficient") {
    return new AppException(
      DUB_ERRORS.noCredits,
      "There are not enough credits for this dub.",
      HttpStatus.PAYMENT_REQUIRED,
      error.details,
    );
  }
  if (error instanceof AppException) return error;
  return new AppException(
    DUB_ERRORS.failed,
    "The dub could not be started. Try again in a moment.",
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

function clipNotReady(): AppException {
  return new AppException(
    DUB_ERRORS.clipNotReady,
    "This clip is not ready to dub yet.",
    HttpStatus.CONFLICT,
  );
}

function runStopped(): AppException {
  return new AppException(
    DUB_ERRORS.runStopped,
    "This run was stopped, so nothing new can be made from it.",
    HttpStatus.CONFLICT,
  );
}

function secondsToUtcMidnight(now: number = Date.now()): number {
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((midnight.getTime() - now) / 1000));
}
