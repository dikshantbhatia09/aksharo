import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { ulid } from "ulid";

import { formatCredits, type Env } from "@montaj/config";
import { isVoiceoverItem, newId, stableOverlayId, voiceoverPass } from "@montaj/edg";
import type { EdgOp, PassItem } from "@montaj/edg/schemas";
import {
  AiVoiceoverPayloadSchema,
  AiVoiceoverResultSchema,
  REPURPOSE_SCHEMA_VERSION,
  VOICEOVER_LIMITS,
  VOICEOVER_MODEL,
  aiVoiceoverJobKey,
  voiceoverAudioKey,
  type VoiceoverLanguage,
  type VoiceoverSpeaker,
} from "@montaj/repurpose-contracts";
import { fromAcceptedItems } from "@montaj/timemap";

import { VoiceoverBudget } from "./voiceover-budget.js";
import {
  VOICEOVER_SPEAKER_OPTIONS,
  voiceoverLanguageOf,
  voiceoverLanguageOption,
  type VoiceoverLanguageOption,
  type VoiceoverSpeakerOption,
} from "./voiceover-languages.js";
import { VOICEOVER_TENTHS, voiceoverVendorPaise } from "./voiceover-pricing.js";
import {
  DEFAULT_VOICEOVER_SPEAKER,
  MAX_LIVE_VOICEOVERS_PER_WORKSPACE,
  NOT_RETRYABLE_FAILURES,
  VENDOR_WORDS,
  VOICEOVER_ERRORS,
  VOICEOVER_FLAG,
  VOICEOVER_PACE,
  VOICEOVER_PLACE_WINDOW_MS,
  VOICEOVER_SWEEP_BATCH,
  VOICEOVER_URL_TTL_SECONDS,
} from "./voiceover.constants.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, PrismaService } from "../../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../../common/storage/index.js";
import { ENV } from "../../config/config.module.js";
import { EdgRepository, EdgService } from "../../edg/index.js";
import { JOB_ERROR_CODES } from "../../jobs/jobs.errors.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { EntitlementService } from "../../workspaces/entitlement.service.js";
import { finishingInProgress } from "../clip-finishing.js";
import {
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  RECONCILE_INTERVAL_MS,
} from "../repurpose.constants.js";
import { isRemoved } from "../steering.js";

import type { CreateVoiceoverInput } from "./voiceovers.dto.js";
import type { $Enums, ClipVoiceover, Prisma, RepurposeRun } from "@prisma/client";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A voice-over as `GET .../voiceovers` returns it. */
export interface VoiceoverView {
  readonly id: string;
  readonly runId: string;
  readonly clipId: string;
  readonly status: $Enums.VoiceoverStatus;
  readonly failureCode: string | null;
  /** The vendor's own words, for a refusal only. */
  readonly failureMessage: string | null;
  readonly text: string;
  readonly language: VoiceoverLanguageOption;
  readonly speaker: VoiceoverSpeakerOption;
  readonly durationMs: number | null;
  readonly costTenths: number;
  /** A signed URL to listen to the voice on its own, once made. */
  readonly audioUrl: string | null;
  /** How many of the clip's shapes carry it now. */
  readonly placedShapes: number;
  readonly canRetry: boolean;
  readonly canRemove: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What a clip offers the "Add a voice-over hook" dialog: whether it can take
 * one, the line it would say (its hook), the language it would say it in, and
 * the voice-over it already has, if any.
 */
export interface VoiceoverOfferView {
  readonly clipId: string;
  readonly ready: boolean;
  readonly text: string;
  readonly language: VoiceoverLanguageOption | null;
  readonly voiceoverId: string | null;
}

export interface VoiceoverListView {
  readonly runId: string;
  /** `repurpose_voiceover` is on for this workspace: the page offers the action. */
  readonly enabled: boolean;
  /** Credits (tenths) one voice-over costs. */
  readonly tenthsPerVoiceover: number;
  readonly maxTextChars: number;
  readonly speakers: readonly VoiceoverSpeakerOption[];
  readonly clips: readonly VoiceoverOfferView[];
  readonly voiceovers: readonly VoiceoverView[];
}

/** A clip with each shape's project: its document, its media and its newest transcript. */
const CLIP_INCLUDE = {
  candidate: true,
  variants: {
    select: {
      id: true,
      aspect: true,
      projectId: true,
      finishing: true,
      project: {
        select: {
          edgDocument: { select: { id: true } },
          transcripts: {
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { language: true },
          },
        },
      },
    },
  },
} as const satisfies Prisma.RepurposeClipInclude;

type ClipWithShapes = Prisma.RepurposeClipGetPayload<{ include: typeof CLIP_INCLUDE }>;
type ShapeRow = ClipWithShapes["variants"][number];

/** Voice-overs on their way: the watchdog carries them on whatever the run does. */
const LIVE: readonly $Enums.VoiceoverStatus[] = ["waiting", "speaking"];
/** A clip has at most one of these at a time. */
const HELD: readonly $Enums.VoiceoverStatus[] = ["waiting", "speaking", "ready"];

/**
 * The voice-over hook (2026-10-01, OpusClip parity wave 4): a short spoken
 * line at the start of a clip - its hook read by a stock synthetic voice in the
 * clip's language - with the clip's own sound pulled down under it.
 *
 * One request is ONE text-to-speech call (`ai.voiceover` in worker-ai, Sarvam's
 * `bulbul`). The voice is then laid on EVERY shape's editing document as an
 * accepted `sfx` cue (`@montaj/edg` `voiceoverPass`: `playThrough`, and a
 * `dialogueDuck` under it), never baked into the clip's media - so the cloud
 * render and the browser export mix it from the same place, the editor's sound
 * row shows it, a person takes it off by rejecting it, and the captioned
 * videos are made again with it after the usual quiet minute (the document's
 * revision changed). Shapes cut later (Autopilot's other sizes) get it as they
 * arrive, by the run's reconcile; a shape still being finished gets it once
 * finishing is done, so a cut at its start cannot clip the first word.
 *
 * It holds to the dubbing rules (`../dubbing/dubs.service.ts`), scaled down:
 *
 *   * **Behind its own flag** (`repurpose_voiceover`), which nothing creates: it
 *     is off until the owner turns it on.
 *   * **Money is decided before anything starts.** The credits must be in the
 *     balance; the vendor's rupees must fit today's voice-over budget, charged
 *     atomically at request time. The credits are held on the `ai.voiceover`
 *     job, settled when the voice comes back and released when it fails; the
 *     rupees go back when the vendor was never asked.
 *   * **The vendor is paid once per file**: the worker records the stored file
 *     on its job (`jobs.checkpoint`) and a retried attempt answers from it.
 *   * **Stock voices only**, so nobody's voice is cloned and no consent tick is
 *     needed; who asked, and the words, are on the row and in `audit_log`.
 *   * **A full plan lane is a wait**: the voice-over stays `waiting` and the
 *     reconcile starts it.
 */
@Injectable()
export class RepurposeVoiceoversService {
  private readonly logger = new Logger(RepurposeVoiceoversService.name);
  /** When each run's voice-overs were last reconciled from a read. Per process. */
  private readonly reconciledAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly entitlements: EntitlementService,
    private readonly audit: CommonAuditService,
    private readonly budget: VoiceoverBudget,
    private readonly edg: EdgService,
    private readonly edgRepository: EdgRepository,
    @Inject(ENV) private readonly env: Env,
    @Inject(DERIVED_STORE) private readonly derived: ObjectStore,
  ) {}

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  async list(workspaceId: string, runId: string): Promise<VoiceoverListView> {
    await this.assertFlow(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const enabled = await this.flagOn(workspaceId, VOICEOVER_FLAG);
    if (this.dueForReconcile(run.id)) {
      await this.reconcileRun(run.id, { placeAll: true }).catch((error: unknown) => {
        this.logger.warn({ runId: run.id, err: error }, "voice-over reconcile failed; list served");
      });
    }
    const [clips, voiceovers] = await Promise.all([
      this.clipsOf(run.id),
      this.prisma.clipVoiceover.findMany({
        where: { runId: run.id, status: { not: "removed" } },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    const shown = clips.filter((clip) => !isRemoved(clip.candidate));
    const shownIds = new Set(shown.map((clip) => clip.id));
    const visible = voiceovers.filter((row) => shownIds.has(row.clipId));
    return {
      runId: run.id,
      enabled,
      tenthsPerVoiceover: VOICEOVER_TENTHS,
      maxTextChars: VOICEOVER_LIMITS.maxTextChars,
      speakers: VOICEOVER_SPEAKER_OPTIONS,
      clips: shown.map((clip) => offerOf(clip, run, visible)),
      voiceovers: await Promise.all(visible.map((row) => this.viewOf(row))),
    };
  }

  /**
   * Add a voice-over to a clip. The same words and voice asked for again while
   * the clip's voice-over is live or made answer with it (`created: false`);
   * anything else while it has one is refused - take it off first.
   */
  async create(
    workspaceId: string,
    userId: string,
    runId: string,
    clipId: string,
    input: CreateVoiceoverInput,
  ): Promise<{ readonly voiceover: VoiceoverView; readonly created: boolean }> {
    await this.assertFlow(workspaceId);
    await this.assertEnabled(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") throw runStopped();
    const clip = await this.requireClip(run, clipId);
    if (!hasDocument(clip)) throw clipNotReady();

    const language = clipLanguageOf(clip, run);
    if (language === null) {
      throw new AppException(
        VOICEOVER_ERRORS.languageUnsupported,
        "A voice-over cannot be spoken in this clip's language yet.",
        HttpStatus.CONFLICT,
      );
    }
    const text = (input.text ?? defaultHookOf(clip)).replace(/\s+/gu, " ").trim();
    if (text.length < VOICEOVER_LIMITS.minTextChars) {
      throw new AppException(
        VOICEOVER_ERRORS.noText,
        "This clip has no hook line to say. Write the words for the voice-over.",
        HttpStatus.BAD_REQUEST,
      );
    }
    if (text.length > VOICEOVER_LIMITS.maxTextChars) {
      throw new AppException(
        VOICEOVER_ERRORS.noText,
        `A voice-over says at most ${String(VOICEOVER_LIMITS.maxTextChars)} characters.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const speaker: VoiceoverSpeaker = input.speaker ?? DEFAULT_VOICEOVER_SPEAKER;

    // The same request twice (a double click, a retried request) is one voice-over.
    const held = await this.prisma.clipVoiceover.findFirst({
      where: { clipId: clip.id, status: { in: [...HELD] } },
    });
    if (held !== null) {
      if (held.text === text && held.speaker === speaker) {
        return { voiceover: await this.viewOf(held), created: false };
      }
      throw new AppException(
        VOICEOVER_ERRORS.alreadyHas,
        "This clip already has a voice-over. Take it off first to make a new one.",
        HttpStatus.CONFLICT,
        { voiceoverId: held.id },
      );
    }

    await this.assertAffordable(workspaceId, VOICEOVER_TENTHS);
    await this.assertRoomForAnother(workspaceId);
    const paise = voiceoverVendorPaise(text.length);
    const reserved = await this.reserveBudget(paise);

    let row: ClipVoiceover;
    try {
      row = await this.prisma.clipVoiceover.create({
        data: {
          id: ulid(),
          runId: run.id,
          clipId: clip.id,
          workspaceId: run.workspaceId,
          text,
          language,
          speaker,
          status: "waiting",
          costTenths: VOICEOVER_TENTHS,
          budgetDay: reserved.day,
          budgetPaise: paise,
          createdBy: userId,
        },
      });
    } catch (error) {
      await this.budget.release(reserved.day, paise);
      throw error;
    }

    try {
      await this.start(row);
    } catch (error) {
      // Refused before anything was spent: nothing is left behind.
      await this.prisma.clipVoiceover.deleteMany({ where: { id: row.id, jobId: null } });
      await this.budget.release(reserved.day, paise);
      throw translateRefusal(error);
    }

    await this.audit.record({
      action: "repurpose.voiceover.requested",
      resource: "clip_voiceover",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: {
        runId: run.id,
        clipId: clip.id,
        text,
        language,
        speaker,
        costTenths: VOICEOVER_TENTHS,
        vendorPaise: paise,
      },
    });
    return { voiceover: await this.viewById(row.id), created: true };
  }

  /** Make a failed voice-over again; the day's budget is charged for the new call. */
  async retry(
    workspaceId: string,
    userId: string,
    runId: string,
    voiceoverId: string,
  ): Promise<VoiceoverView> {
    await this.assertFlow(workspaceId);
    await this.assertEnabled(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    if (run.status === "cancelled") throw runStopped();
    const row = await this.requireVoiceover(run, voiceoverId);
    if (!canRetry(row)) {
      throw new AppException(
        VOICEOVER_ERRORS.notRetryable,
        row.status === "failed"
          ? "This voice-over was refused for a reason trying again would not change."
          : "This voice-over is not one that failed.",
        HttpStatus.CONFLICT,
        { status: row.status, failureCode: row.failureCode },
      );
    }
    await this.requireClip(run, row.clipId);
    await this.assertAffordable(workspaceId, row.costTenths);
    await this.assertRoomForAnother(workspaceId);
    const paise = voiceoverVendorPaise(row.text.length);
    const reserved = await this.reserveBudget(paise);

    const { count } = await this.prisma.clipVoiceover.updateMany({
      where: { id: row.id, status: "failed" },
      data: {
        status: "waiting",
        failureCode: null,
        failureMessage: null,
        completedAt: null,
        budgetDay: reserved.day,
        budgetPaise: paise,
      },
    });
    if (count === 0) {
      await this.budget.release(reserved.day, paise);
      throw new AppException(
        VOICEOVER_ERRORS.notRetryable,
        "This voice-over is already being tried again.",
        HttpStatus.CONFLICT,
      );
    }
    const fresh = {
      ...row,
      status: "waiting" as const,
      budgetDay: reserved.day,
      budgetPaise: paise,
    };
    try {
      await this.start(fresh);
    } catch (error) {
      await this.fail(row.id, error instanceof AppException ? error.code : VOICEOVER_ERRORS.failed);
      await this.giveBudgetBack(fresh);
      throw translateRefusal(error);
    }
    await this.audit.record({
      action: "repurpose.voiceover.retried",
      resource: "clip_voiceover",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, fromFailure: row.failureCode },
    });
    return this.viewById(row.id);
  }

  /**
   * Take a voice-over off its clip: its cue is rejected on every shape's
   * document (the captioned videos are made again without it), or - while it
   * is still being made - its job is cancelled and the credits come back.
   */
  async remove(
    workspaceId: string,
    userId: string,
    runId: string,
    voiceoverId: string,
  ): Promise<VoiceoverView> {
    await this.assertFlow(workspaceId);
    const run = await this.requireRun(workspaceId, runId);
    const row = await this.requireVoiceover(run, voiceoverId);
    if (row.status === "removed") return this.viewOf(row);
    const from = row.status;

    const { count } = await this.prisma.clipVoiceover.updateMany({
      where: { id: row.id, status: from },
      data: { status: "removed", completedAt: row.completedAt ?? new Date() },
    });
    if (count === 0) {
      throw new AppException(
        VOICEOVER_ERRORS.notRemovable,
        "This voice-over changed a moment ago. Try again.",
        HttpStatus.CONFLICT,
      );
    }
    if (from === "speaking" && row.jobId !== null) {
      await this.jobs.cancel(row.jobId, row.workspaceId).catch((error: unknown) => {
        // Finished a moment ago: its file is stored and simply never placed.
        if (!(error instanceof AppException && error.code === JOB_ERROR_CODES.invalidState)) {
          throw error;
        }
      });
    }
    if (from === "waiting") await this.giveBudgetBack(row);
    const taken = await this.takeOff(row);

    await this.audit.record({
      action: "repurpose.voiceover.removed",
      resource: "clip_voiceover",
      resourceId: row.id,
      actorId: userId,
      workspaceId,
      data: { runId: run.id, clipId: row.clipId, fromStatus: from, shapes: taken },
    });
    return this.viewById(row.id);
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * Move a run's voice-overs on: a waiting one is offered the lane, one whose
   * job ended without its completion landing is settled from the job, and a
   * made one is laid on any shape that does not carry it yet. Never throws for
   * one voice-over.
   */
  async reconcileRun(runId: string, options: { readonly placeAll?: boolean } = {}): Promise<void> {
    this.markReconciled(runId);
    const rows = await this.prisma.clipVoiceover.findMany({
      where: { runId, status: { in: [...LIVE, "ready"] } },
      orderBy: { createdAt: "asc" },
    });
    for (const row of rows) {
      try {
        if (row.status === "ready" && options.placeAll !== true && !recentlyMade(row)) continue;
        if ((await this.reconcileOne(row)) === "lane_full") break;
      } catch (error) {
        this.logger.warn({ voiceoverId: row.id, err: error }, "could not move a voice-over on");
      }
    }
  }

  /** The watchdog's pass (`RepurposeReconciler`): live voice-overs, and fresh ones to place. */
  async sweep(): Promise<void> {
    try {
      const since = new Date(Date.now() - VOICEOVER_PLACE_WINDOW_MS);
      const rows = await this.prisma.clipVoiceover.findMany({
        where: {
          OR: [{ status: { in: [...LIVE] } }, { status: "ready", completedAt: { gte: since } }],
        },
        select: { runId: true },
        orderBy: { createdAt: "asc" },
        take: VOICEOVER_SWEEP_BATCH,
      });
      for (const runId of new Set(rows.map((row) => row.runId))) {
        await this.reconcileRun(runId).catch((error: unknown) => {
          this.logger.warn({ runId, err: error }, "could not reconcile a run's voice-overs");
        });
      }
    } catch (error) {
      this.logger.warn({ err: error }, "voice-over sweep failed; the next one retries");
    }
  }

  private async reconcileOne(row: ClipVoiceover): Promise<"lane_full" | "done"> {
    switch (row.status) {
      case "waiting": {
        try {
          return (await this.start(row)) === "waiting" ? "lane_full" : "done";
        } catch (error) {
          this.logger.warn(
            { voiceoverId: row.id, err: error },
            "a waiting voice-over could not start",
          );
          await this.fail(row.id, translateRefusal(error).code);
          await this.giveBudgetBack(row);
          return "done";
        }
      }
      case "speaking":
        await this.settleLost(row);
        return "done";
      case "ready":
        await this.place(row);
        return "done";
      default:
        return "done";
    }
  }

  // -------------------------------------------------------------------------
  // The vendor's part
  // -------------------------------------------------------------------------

  /** Ask for the `ai.voiceover` job: `speaking` when queued, `waiting` when the lane is full. */
  private async start(row: ClipVoiceover): Promise<"speaking" | "waiting"> {
    const run = await this.prisma.repurposeRun.findUniqueOrThrow({ where: { id: row.runId } });
    const attempt = row.attempts + 1;
    const payload = AiVoiceoverPayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: run.id,
      clipId: row.clipId,
      voiceoverId: row.id,
      text: row.text,
      language: row.language,
      speaker: row.speaker,
      pace: VOICEOVER_PACE,
      model: VOICEOVER_MODEL,
      destination: { key: this.keyOf(run, row) },
    });
    try {
      const { job } = await this.jobs.enqueue({
        type: "ai.voiceover",
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        params: payload,
        jobKey: aiVoiceoverJobKey(row.id, attempt),
        worstCaseTenths: row.costTenths,
        reason: `ai.voiceover · ${row.language} · ${row.id}`,
      });
      await this.prisma.clipVoiceover.updateMany({
        where: { id: row.id, status: "waiting" },
        data: { status: "speaking", jobId: job.id, attempts: attempt },
      });
      return "speaking";
    } catch (error) {
      if (isLaneFull(error)) return "waiting";
      throw error;
    }
  }

  /**
   * The voice is stored: record it, and lay it on the clip's shapes. Called by
   * the `ai.voiceover` completion handler; conditional on the voice-over still
   * speaking with this job, so a replay changes nothing.
   * @returns the tenths the job settles: the voice-over's price, or 0.
   */
  async applySpoken(
    voiceoverId: string,
    jobId: string,
    result: { readonly key: string; readonly durationMs: number },
  ): Promise<number> {
    const row = await this.prisma.clipVoiceover.findUnique({ where: { id: voiceoverId } });
    if (row === null) return 0;
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: row.runId } });
    if (run === null) return 0;
    if (result.key !== this.keyOf(run, row)) {
      await this.applyJobFailed(row.id, jobId, {
        code: VOICEOVER_ERRORS.resultMismatch,
        message: "the worker reported a file it was not asked to write",
      });
      return 0;
    }
    const { count } = await this.prisma.clipVoiceover.updateMany({
      where: { id: row.id, jobId, status: "speaking" },
      data: {
        status: "ready",
        audioKey: result.key,
        audioDurationMs: result.durationMs,
        failureCode: null,
        failureMessage: null,
        completedAt: new Date(),
      },
    });
    if (count === 0) return 0;
    const made = await this.prisma.clipVoiceover.findUnique({ where: { id: row.id } });
    if (made !== null) {
      await this.place(made).catch((error: unknown) => {
        this.logger.warn({ voiceoverId: row.id, err: error }, "voice-over made; placing it later");
      });
    }
    return row.costTenths;
  }

  /**
   * The voice-over's job failed (worker-reported, cancelled, stalled): it
   * fails with the job's code. The rupees go back when the vendor was not
   * billed (its key was refused, it refused the words, or it was never asked).
   */
  async applyJobFailed(
    voiceoverId: string,
    jobId: string,
    error: { readonly code?: string; readonly message?: string } | null,
  ): Promise<void> {
    const row = await this.prisma.clipVoiceover.findUnique({ where: { id: voiceoverId } });
    if (row === null || row.jobId !== jobId || row.status !== "speaking") return;
    const code = failureCodeOf(error?.code);
    const message =
      VENDOR_WORDS.has(code) && typeof error?.message === "string" && error.message.trim() !== ""
        ? error.message.slice(0, 300)
        : null;
    const { count } = await this.prisma.clipVoiceover.updateMany({
      where: { id: row.id, jobId, status: "speaking" },
      data: {
        status: "failed",
        failureCode: code,
        failureMessage: message,
        completedAt: new Date(),
      },
    });
    if (count > 0 && UNBILLED_FAILURES.has(code)) await this.giveBudgetBack(row);
  }

  /** A voice-over still speaking whose job ended without its handler's write landing. */
  private async settleLost(row: ClipVoiceover): Promise<void> {
    if (row.jobId === null) return;
    const job = await this.prisma.job.findUnique({ where: { id: row.jobId } });
    if (job === null || job.status === "queued" || job.status === "running") return;
    if (job.status === "succeeded") {
      const parsed = AiVoiceoverResultSchema.safeParse(job.result);
      if (parsed.success && parsed.data.voiceoverId === row.id) {
        await this.applySpoken(row.id, job.id, parsed.data);
        return;
      }
    }
    await this.applyJobFailed(
      row.id,
      job.id,
      (job.error as { code?: string; message?: string } | null) ?? null,
    );
  }

  // -------------------------------------------------------------------------
  // On the documents
  // -------------------------------------------------------------------------

  /**
   * Lay a made voice-over on every shape of its clip that does not carry it:
   * one accepted `sfx` cue from where the finished video starts. A shape with
   * no document yet, or still being finished, is left for a later pass. A
   * shape a person already took it off (its cue rejected) keeps it off.
   */
  private async place(row: ClipVoiceover): Promise<number> {
    if (row.status !== "ready" || row.audioDurationMs === null) return 0;
    const clip = await this.prisma.repurposeClip.findUnique({
      where: { id: row.clipId },
      include: CLIP_INCLUDE,
    });
    if (clip === null) return 0;
    const placements = placementsOf(row.placements);
    let added = 0;
    for (const shape of clip.variants) {
      if (Object.hasOwn(placements, shape.id)) continue;
      if (shape.project.edgDocument === null || finishingInProgress(shape.finishing)) continue;
      try {
        const itemId = await this.placeOnShape(row, shape);
        if (itemId === undefined) continue;
        placements[shape.id] = itemId;
        added += 1;
      } catch (error) {
        this.logger.warn(
          { voiceoverId: row.id, variantId: shape.id, err: error },
          "could not lay a voice-over on a clip shape; the next pass tries again",
        );
      }
    }
    if (added > 0) {
      await this.prisma.clipVoiceover.updateMany({
        where: { id: row.id, status: "ready" },
        data: { placements: placements as unknown as Prisma.InputJsonValue },
      });
      this.logger.log({ voiceoverId: row.id, shapes: added }, "laid a voice-over on clip shapes");
    }
    return added;
  }

  /** One shape: the cue's item id once the document holds it, else `undefined`. */
  private async placeOnShape(row: ClipVoiceover, shape: ShapeRow): Promise<string | undefined> {
    const document = shape.project.edgDocument;
    if (document === null || row.audioDurationMs === null) return undefined;
    const itemId = stableOverlayId(`${shape.id}:voiceover:${row.id}`);
    const passId = stableOverlayId(`${shape.id}:voiceover-pass:${row.id}`);
    const projection = await this.edgRepository.projectionOf(document.id);
    const items: PassItem[] = projection.passes.flatMap((pass) => pass.items);
    // Already there (a repeated ask, or a pass that landed before its record).
    if (items.some((item) => item.itemId === itemId)) return itemId;
    const revision = await this.prisma.edgDocument.findUnique({
      where: { id: document.id },
      select: { revision: true },
    });
    if (revision === null) return undefined;
    const sourceDurationMs =
      projection.media.find((media) => media.role === "primary")?.durationMs ?? 0;
    if (sourceDurationMs <= 0) return undefined;
    const startMs = fromAcceptedItems(items, { sourceDurationMs }).toSource(0);
    const cuePass = voiceoverPass({
      voiceoverId: row.id,
      startMs,
      durationMs: row.audioDurationMs,
      text: row.text,
      language: row.language,
      speaker: row.speaker,
      passId,
      itemId,
    });
    if (cuePass === undefined) return undefined;
    const opId = newId();
    const response = await this.edg.applyWorkerOps({
      projectId: shape.projectId,
      baseRevision: revision.revision,
      ops: [{ opId, type: "MergePass", pass: cuePass } satisfies EdgOp],
      clientOpIds: [],
    });
    if (response.rejected.length > 0) {
      this.logger.warn(
        { voiceoverId: row.id, variantId: shape.id, rejected: response.rejected.slice(0, 3) },
        "a voice-over was refused by the document",
      );
    }
    return [...response.applied, ...response.rebased].includes(opId) ? itemId : undefined;
  }

  /** Reject the voice-over's cue on every shape that carries it. @returns how many. */
  private async takeOff(row: ClipVoiceover): Promise<number> {
    const placements = placementsOf(row.placements);
    const variantIds = Object.keys(placements);
    if (variantIds.length === 0) return 0;
    const shapes = await this.prisma.clipVariant.findMany({
      where: { id: { in: variantIds } },
      select: { id: true, projectId: true, project: { select: { edgDocument: true } } },
    });
    let taken = 0;
    for (const shape of shapes) {
      const document = shape.project.edgDocument;
      const itemId = placements[shape.id];
      if (document === null || itemId === undefined) continue;
      try {
        const projection = await this.edgRepository.projectionOf(document.id);
        const item = projection.passes
          .flatMap((pass) => pass.items)
          .find((entry) => entry.itemId === itemId);
        if (item === undefined || item.state === "rejected" || !isVoiceoverItem(item)) continue;
        await this.edg.applyWorkerOps({
          projectId: shape.projectId,
          baseRevision: document.revision,
          ops: [{ opId: newId(), type: "DecideItems", itemIds: [itemId], state: "rejected" }],
          clientOpIds: [],
        });
        taken += 1;
      } catch (error) {
        this.logger.warn(
          { voiceoverId: row.id, variantId: shape.id, err: error },
          "could not take a voice-over off a clip shape",
        );
      }
    }
    return taken;
  }

  // -------------------------------------------------------------------------
  // Views and guards
  // -------------------------------------------------------------------------

  private async viewById(id: string): Promise<VoiceoverView> {
    return this.viewOf(await this.prisma.clipVoiceover.findUniqueOrThrow({ where: { id } }));
  }

  private async viewOf(row: ClipVoiceover): Promise<VoiceoverView> {
    const audioUrl =
      row.status === "ready" && row.audioKey !== null
        ? await this.derived.presignGet(row.audioKey, VOICEOVER_URL_TTL_SECONDS).catch(() => null)
        : null;
    const speaker =
      VOICEOVER_SPEAKER_OPTIONS.find((option) => option.id === row.speaker) ??
      ({ id: row.speaker as VoiceoverSpeaker, name: row.speaker } satisfies VoiceoverSpeakerOption);
    return {
      id: row.id,
      runId: row.runId,
      clipId: row.clipId,
      status: row.status,
      failureCode: row.failureCode,
      failureMessage: row.failureMessage,
      text: row.text,
      language: voiceoverLanguageOption(row.language as VoiceoverLanguage),
      speaker,
      durationMs: row.audioDurationMs,
      costTenths: row.costTenths,
      audioUrl,
      placedShapes: Object.keys(placementsOf(row.placements)).length,
      canRetry: canRetry(row),
      canRemove: row.status !== "removed",
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async assertAffordable(workspaceId: string, costTenths: number): Promise<void> {
    const account = await this.prisma.creditAccount.findUnique({
      where: { workspaceId },
      select: { balanceTenths: true },
    });
    const balance = account?.balanceTenths ?? 0;
    if (balance < costTenths) {
      throw new AppException(
        VOICEOVER_ERRORS.noCredits,
        `A voice-over costs ${formatCredits(costTenths)} credits and you have ${formatCredits(balance)}.`,
        HttpStatus.PAYMENT_REQUIRED,
        { costTenths, balanceTenths: balance, shortfallTenths: costTenths - balance },
      );
    }
  }

  private async assertRoomForAnother(workspaceId: string): Promise<void> {
    const live = await this.prisma.clipVoiceover.count({
      where: { workspaceId, status: { in: [...LIVE] } },
    });
    if (live >= MAX_LIVE_VOICEOVERS_PER_WORKSPACE) {
      throw new AppException(
        VOICEOVER_ERRORS.tooMany,
        `${String(live)} voice-overs are already being made. Try again when one has finished.`,
        HttpStatus.TOO_MANY_REQUESTS,
        { live, limit: MAX_LIVE_VOICEOVERS_PER_WORKSPACE, retryAfterSeconds: 30 },
      );
    }
  }

  private async reserveBudget(paise: number): Promise<{ readonly day: string }> {
    const decision = await this.budget.reserve(paise);
    if (decision.ok) return { day: decision.day };
    throw new AppException(
      VOICEOVER_ERRORS.budgetReached,
      "Voice-overs have reached today's limit. Try again tomorrow (the day starts at 05:30 IST).",
      HttpStatus.TOO_MANY_REQUESTS,
      { day: decision.day },
    );
  }

  /** Give a voice-over's rupees back to its day, once. */
  private async giveBudgetBack(row: ClipVoiceover): Promise<void> {
    if (row.budgetDay === null || row.budgetPaise <= 0) return;
    const { count } = await this.prisma.clipVoiceover.updateMany({
      where: { id: row.id, budgetPaise: row.budgetPaise },
      data: { budgetPaise: 0 },
    });
    if (count > 0) await this.budget.release(row.budgetDay, row.budgetPaise);
  }

  private async fail(id: string, code: string): Promise<void> {
    await this.prisma.clipVoiceover
      .updateMany({
        where: { id, status: { in: [...LIVE] } },
        data: { status: "failed", failureCode: code, completedAt: new Date() },
      })
      .catch(() => undefined);
  }

  private keyOf(run: RepurposeRun, row: { readonly id: string }): string {
    return voiceoverAudioKey({
      workspaceId: run.workspaceId,
      sourceProjectId: run.sourceProjectId,
      runId: run.id,
      voiceoverId: row.id,
    });
  }

  private async clipsOf(runId: string): Promise<ClipWithShapes[]> {
    return this.prisma.repurposeClip.findMany({
      where: { runId },
      include: CLIP_INCLUDE,
      orderBy: { createdAt: "asc" },
    });
  }

  private async requireClip(run: RepurposeRun, clipId: string): Promise<ClipWithShapes> {
    const clip = await this.prisma.repurposeClip.findFirst({
      where: { id: clipId, runId: run.id },
      include: CLIP_INCLUDE,
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
        VOICEOVER_ERRORS.clipRemoved,
        "This moment was removed. Bring it back before adding a voice-over.",
        HttpStatus.CONFLICT,
      );
    }
    return clip;
  }

  private async requireVoiceover(run: RepurposeRun, id: string): Promise<ClipVoiceover> {
    const row = await this.prisma.clipVoiceover.findFirst({ where: { id, runId: run.id } });
    if (row === null) {
      throw new AppException(
        VOICEOVER_ERRORS.notFound,
        "We could not find that voice-over.",
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
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

  private async assertEnabled(workspaceId: string): Promise<void> {
    if (await this.flagOn(workspaceId, VOICEOVER_FLAG)) return;
    throw new AppException(
      VOICEOVER_ERRORS.notEnabled,
      "Voice-overs are not switched on for this workspace.",
      HttpStatus.FORBIDDEN,
    );
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

/**
 * Failures after which the vendor did not bill: it was never asked (no key, a
 * payload refused), refused the key, or refused the words. Every other failure
 * keeps its rupees counted, the safe way to be wrong.
 */
const UNBILLED_FAILURES: ReadonlySet<string> = new Set([
  VOICEOVER_ERRORS.notConfigured,
  VOICEOVER_ERRORS.vendorAuth,
  VOICEOVER_ERRORS.vendorRefused,
  VOICEOVER_ERRORS.resultMismatch,
  "worker/invalid_payload",
  // Never picked up from the queue, so never sent.
  JOB_ERROR_CODES.queueTimeout,
]);

/** The words a voice-over says by default: the clip's hook, else its title. */
export function defaultHookOf(clip: { readonly copy: unknown; readonly title: string }): string {
  const copy = clip.copy;
  const hook =
    typeof copy === "object" && copy !== null && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)["hook"]
      : undefined;
  if (typeof hook === "string" && hook.trim() !== "") {
    return hook.replace(/\s+/gu, " ").trim().slice(0, VOICEOVER_LIMITS.maxTextChars);
  }
  // A person's unnamed moment ("Moment at 1:23-1:45") is a label, not a line.
  if (/^Moment at \d/u.test(clip.title.trim())) return "";
  return clip.title.replace(/\s+/gu, " ").trim().slice(0, VOICEOVER_LIMITS.maxTextChars);
}

/** The clip's language for the voice: its 9:16 transcript's, else the run's choice. */
export function clipLanguageOf(
  clip: ClipWithShapes,
  run: Pick<RepurposeRun, "config">,
): VoiceoverLanguage | null {
  const vertical = clip.variants.find((variant) => variant.aspect === "r9x16") ?? clip.variants[0];
  const configured = (run.config as { sourceLanguage?: unknown } | null)?.sourceLanguage;
  const tag =
    vertical?.project.transcripts[0]?.language ??
    (typeof configured === "string" ? configured : null);
  return voiceoverLanguageOf(tag);
}

function hasDocument(clip: ClipWithShapes): boolean {
  return clip.mezzanineKey !== null && clip.variants.some((v) => v.project.edgDocument !== null);
}

function offerOf(
  clip: ClipWithShapes,
  run: RepurposeRun,
  rows: readonly ClipVoiceover[],
): VoiceoverOfferView {
  const language = clipLanguageOf(clip, run);
  const held = rows.find((row) => row.clipId === clip.id && HELD.includes(row.status));
  return {
    clipId: clip.id,
    ready: hasDocument(clip) && language !== null,
    text: defaultHookOf(clip),
    language: language === null ? null : voiceoverLanguageOption(language),
    voiceoverId: held?.id ?? null,
  };
}

/** `{variantId: itemId}`, as the row stores it; anything unreadable is empty. */
function placementsOf(value: Prisma.JsonValue | null | undefined): Record<string, string> {
  const placements: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return placements;
  for (const [variantId, itemId] of Object.entries(value)) {
    // eslint-disable-next-line security/detect-object-injection -- keys copied from our own JSON
    if (typeof itemId === "string") placements[variantId] = itemId;
  }
  return placements;
}

function recentlyMade(row: ClipVoiceover, now = Date.now()): boolean {
  return row.completedAt !== null && now - row.completedAt.getTime() < VOICEOVER_PLACE_WINDOW_MS;
}

function canRetry(row: ClipVoiceover): boolean {
  return row.status === "failed" && !NOT_RETRYABLE_FAILURES.has(row.failureCode ?? "");
}

function failureCodeOf(code: string | undefined): string {
  if (typeof code !== "string" || code === "") return VOICEOVER_ERRORS.failed;
  return code.slice(0, 128);
}

function isLaneFull(error: unknown): boolean {
  return (
    error instanceof AppException &&
    (error.code === JOB_ERROR_CODES.concurrencyCap || error.code === JOB_ERROR_CODES.enqueueCap)
  );
}

function translateRefusal(error: unknown): AppException {
  if (error instanceof AppException && error.code === "credits/insufficient") {
    return new AppException(
      VOICEOVER_ERRORS.noCredits,
      "There are not enough credits for this voice-over.",
      HttpStatus.PAYMENT_REQUIRED,
      error.details,
    );
  }
  if (error instanceof AppException) return error;
  return new AppException(
    VOICEOVER_ERRORS.failed,
    "The voice-over could not be started. Try again in a moment.",
    HttpStatus.SERVICE_UNAVAILABLE,
  );
}

function clipNotReady(): AppException {
  return new AppException(
    VOICEOVER_ERRORS.clipNotReady,
    "This clip is not ready for a voice-over yet.",
    HttpStatus.CONFLICT,
  );
}

function runStopped(): AppException {
  return new AppException(
    VOICEOVER_ERRORS.runStopped,
    "This run was stopped, so nothing new can be made from it.",
    HttpStatus.CONFLICT,
  );
}
