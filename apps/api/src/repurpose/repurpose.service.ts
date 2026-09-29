import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ulid } from "ulid";

import { TENTHS_PER_CREDIT, type Env } from "@montaj/config";
import {
  type HighlightsPayload,
  MediaAcquirePayloadSchema,
  REPURPOSE_SCHEMA_VERSION,
  highlightsJobKey,
  mediaAcquireJobKey,
} from "@montaj/repurpose-contracts";

import { failureDetailOf, runFailureCode } from "./failure-codes.js";
import { discoveryModelOptionsFor } from "./highlights-options.js";
import {
  ACQUIRE_MAX_BYTES,
  ACQUIRE_MAX_DURATION_MS,
  ACQUIRE_QUOTE_TENTHS,
  ACQUIRED_FILENAME,
  ACQUIRED_MIME,
  DEFAULT_STAGE_DEADLINES_MS,
  DEFAULT_WINDOW_POLICY,
  LIST_RECONCILE_CONCURRENCY,
  MIN_WINDOW_MS,
  PRE_CANDIDATE_STATUSES,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  STAGE_TIMEOUT_CUSTOMER_MESSAGE,
  WINDOW_POLICIES,
  WINDOW_TOLERANCE_MS,
  AUTOPILOT_MIN_POTENTIAL,
  acquireTimeoutMs,
  automationOf,
  autopilotClipCount,
} from "./repurpose.constants.js";
import { createRunSchema } from "./repurpose.dto.js";
import {
  formatClock,
  isCancellable,
  isRetryable,
  nextWindowAvailable,
  progressForStatus,
  projectRun,
  stageForStatus,
  windowView,
} from "./repurpose.projection.js";
import { RunActivityReader } from "./run-activity.reader.js";
import { MAX_BLOCKED_FETCHES, SOURCE_BLOCKED_REASON, SourceGate } from "./source-gate.js";
import { SOURCE_REJECTION_MESSAGES, parseSourceUrl } from "./source-url.js";
import {
  autopilotAskCount,
  discoveryBoundsOf,
  steeringOf,
  steeringOptionsOf,
  withLengthPreset,
} from "./steering.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { AppException, PrismaService } from "../common/index.js";
import { DERIVED_STORE, type ObjectStore } from "../common/storage/index.js";
import { ENV } from "../config/config.module.js";
import { CREDITS_FACADE, type CreditsFacade } from "../credits/credits.facade.js";
import { PLAN_ENQUEUED_CAP_TENTHS } from "../jobs/jobs.config.js";
import { JobsService } from "../jobs/jobs.service.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";
import { MediaService } from "../media/media.service.js";
import { clipsLimitsFor } from "../projects/plan-limits.js";
import { ProjectsService } from "../projects/projects.service.js";
import { workspaceRoom } from "../realtime/realtime.protocol.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";
import { StylesService } from "../styles/styles.service.js";
import { audioReadyEarly, firstTranscriptionJobKey } from "../transcripts/first-transcription.js";
import { quoteTranscription } from "../transcripts/transcripts.quote.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { RunFailureCode, RunFailureDetail } from "./failure-codes.js";
import type { WindowPolicy } from "./repurpose.constants.js";
import type {
  CreateRunInput,
  CreateRunResponse,
  ListRunsInput,
  NextWindowResponse,
  RunPage,
  RunView,
} from "./repurpose.dto.js";
import type { Stage } from "./repurpose.projection.js";
import type { ActivityResult } from "./run-activity.js";
import type { AcquisitionProject } from "../media/media.service.js";
import type { PlanClipsLimits } from "../projects/plan-limits.js";
import type { $Enums, RepurposeRun } from "@prisma/client";

/**
 * The longest window, in whole seconds, whose transcription `tenths` pays for
 * (2026-09-27). The landed file may run {@link WINDOW_TOLERANCE_MS} past its
 * window (a section starts on a keyframe), and the transcription is charged on
 * the file, so the window is sized for the longer file: a Free workspace with
 * exactly 20 credits gets 19:45, not a 20-minute download that then fails its
 * transcription for want of 0.1 credit.
 *
 * The rate is `quoteTranscription`'s, never restated here (1 credit a minute,
 * billed in 0.1-minute steps).
 */
export function affordableWindowMs(tenths: number): number {
  if (!Number.isFinite(tenths) || tenths <= 0) return 0;
  const perMinute = quoteTranscription(60_000).tenths;
  let windowMs = Math.floor(((tenths / perMinute) * 60_000) / 1_000) * 1_000 - WINDOW_TOLERANCE_MS;
  // The quote rounds up to a billing step, so the first guess can be a step
  // over: walk back a second at a time (a handful of steps at most).
  while (windowMs > 0 && quoteTranscription(windowMs + WINDOW_TOLERANCE_MS).tenths > tenths) {
    windowMs -= 1_000;
  }
  return Math.max(0, windowMs);
}

/**
 * How much of a link one run processes: the plan's window, cut to what the
 * balance pays for and to what the plan's enqueued-credit cap would admit as
 * one transcription (`jobs/enqueue_cap`). The cap matters: a window bigger than
 * it would download fine, then have its transcription refused "for now" every
 * time the reconciler tried, and spin for good.
 */
export function runWindowMs(input: {
  readonly clipsWindowMs: number;
  readonly balanceTenths: number;
  readonly enqueuedCapTenths: number;
}): number {
  return Math.min(
    input.clipsWindowMs,
    affordableWindowMs(input.balanceTenths),
    affordableWindowMs(input.enqueuedCapTenths),
  );
}

/** A balance in tenths as the credits a person reads (one decimal), never negative. */
export function creditsOf(tenths: number): number {
  return Math.max(0, Math.floor(tenths)) / TENTHS_PER_CREDIT;
}

/**
 * Where a run started through `RepurposeService.create` comes from, when that
 * is not a person at the start form (2026-10-02): the attestation its source is
 * fetched under - when, by whom, and where it was given (`watch:<id>` for a
 * channel automation).
 */
export interface CreateRunOrigin {
  readonly attestation?: {
    readonly at: Date;
    readonly by: string;
    readonly of: string;
  };
}

/** What a run asks the downloader for, before any budget is applied. */
export interface WindowRequest {
  readonly policy: WindowPolicy;
  readonly startMs?: number;
  /**
   * How long the whole source is, when an earlier fetch of it said so. Only a
   * range reads it: see {@link acquireWindowMaxMs}.
   */
  readonly sourceDurationMs?: number;
}

/** A request's window: a start is a range; otherwise the policy asked for, or the default. */
function windowRequestOf(setup: CreateRunInput["setup"]["window"]): WindowRequest {
  if (setup?.startMs !== undefined) return { policy: "range", startMs: setup.startMs };
  return { policy: setup?.policy ?? DEFAULT_WINDOW_POLICY };
}

/**
 * What a run asked for, read back off its row for a fetch after the first (a
 * retry, the reconciler): a picked start stays picked, an automatic one is
 * chosen again. A run from before windows existed has neither and gets the
 * default - which is what makes a retry of an old "too long for your plan"
 * failure work now.
 */
function windowRequestOfRun(run: RepurposeRun): WindowRequest {
  const policy = (WINDOW_POLICIES as readonly string[]).includes(run.windowPolicy ?? "")
    ? (run.windowPolicy as WindowPolicy)
    : DEFAULT_WINDOW_POLICY;
  if (policy === "range") {
    return run.windowStartMs === null
      ? { policy: DEFAULT_WINDOW_POLICY }
      : {
          policy,
          startMs: run.windowStartMs,
          ...(run.sourceDurationMs === null ? {} : { sourceDurationMs: run.sourceDurationMs }),
        };
  }
  return { policy };
}

/**
 * `window.maxMs` for a download: the budget's window, within the contract, and
 * for a range over a source of known length never past the source's end.
 *
 * That last cut is what keeps a range a range. The downloader takes a section
 * only when the source is LONGER than `maxMs`, and fetches a source that fits
 * whole from 0:00, start or no start. So the next window of a 15-minute video
 * from 7:45, sent with a 19:45 budget, used to fetch - and charge for - all 15
 * minutes again, and duplicate the first window's moments. Sent as the 7:15
 * that is left, the source is longer than the window whenever the start is past
 * 0:00, and the downloader cuts from the start.
 */
export function acquireWindowMaxMs(windowMs: number, window: WindowRequest): number {
  const within = Math.min(windowMs, ACQUIRE_MAX_DURATION_MS);
  const { startMs, sourceDurationMs } = window;
  if (window.policy !== "range" || startMs === undefined || startMs <= 0) return within;
  if (sourceDurationMs === undefined) return within;
  const left = sourceDurationMs - startMs;
  // A start at or past the end has nothing to cut to; the downloader places it.
  return left > 0 ? Math.min(within, left) : within;
}

/**
 * The worst-case transcription quote, in tenths, of a link run still on its way
 * to its transcription: its probed file when there is one, else the window its
 * download asked for, with the file slack the probe allows. Zero for a run whose
 * media failed (it is failing, not transcribing) or that says nothing either way.
 */
export function pendingQuoteTenths(input: {
  readonly mediaStatus: string | null;
  readonly mediaDurationMs: number | null;
  readonly windowMaxMs: number | null;
}): number {
  if (input.mediaStatus === "failed") return 0;
  if (input.mediaDurationMs !== null && input.mediaDurationMs > 0) {
    return quoteTranscription(input.mediaDurationMs).tenths;
  }
  if (input.windowMaxMs !== null && input.windowMaxMs > 0) {
    return quoteTranscription(input.windowMaxMs + WINDOW_TOLERANCE_MS).tenths;
  }
  return 0;
}

/** The plan and the window a link fetch goes out with. */
interface AcquisitionBudget {
  readonly windowMs: number;
  readonly limits: PlanClipsLimits;
}

/** What a run's source is, once `resolveSource` has accepted it. */
interface ResolvedSource {
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
}

/** A language tag worth reasoning in: a real tag, never `"auto"` or blank. */
function usableLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim();
  return tag.length >= 2 && tag.length <= 64 && tag.toLowerCase() !== "auto" ? tag : null;
}

/**
 * The language discovery reasons in (2026-09-27): what the transcript turned
 * out to be, not what the form said. The form's pick is a hint - now `"auto"`
 * by default for clips - and a video sent as Hinglish that detection heard as
 * English has English words to find moments in. The run's own pick is the
 * fallback for a transcript that records none; English the last resort.
 */
export function discoveryLanguage(transcriptLanguage: unknown, configured: unknown): string {
  return usableLanguage(transcriptLanguage) ?? usableLanguage(configured) ?? "en";
}

/** 409 `repurpose/no_next_window`: there is no further part of this video to process. */
function noNextWindow(message: string): AppException {
  return new AppException(REPURPOSE_ERRORS.noNextWindow, message, HttpStatus.CONFLICT);
}

/**
 * The canonical watch URL for a YouTube run's `youtube:{videoId}` fingerprint:
 * the reconciler's `youtubeUrlOf`, which cannot be imported from here (the
 * reconciler imports this module, and its DI metadata needs this class defined).
 */
function youtubeWatchUrl(kind: string, fingerprint: string | null): string | null {
  if (kind !== "youtube_url" || fingerprint === null) return null;
  const match = /^youtube:([\w-]{11})$/.exec(fingerprint);
  return match === null ? null : `https://www.youtube.com/watch?v=${match[1] ?? ""}`;
}

/**
 * What this service needs from `RepurposeReconciler` (`reconciler.ts`).
 *
 * The reconciler moves a run by calling this service's producers, so it
 * depends on this service; this service reads runs through it. Constructor
 * injection both ways is a cycle, so the reconciler registers itself at boot
 * ({@link RepurposeService.useReconciler}), the way completion handlers
 * register with `JobCompletionRegistry`.
 */
export interface RunReconciler {
  reconcile(run: RepurposeRun): Promise<RepurposeRun>;
  reconcileIfDue(run: RepurposeRun, options?: ReconcileReadOptions): Promise<RepurposeRun>;
  redrive(run: RepurposeRun): Promise<RepurposeRun>;
  /** Whether `redrive` would restart anything for this failure, or refuse it. */
  retryPossible(run: RepurposeRun, failureCode: string | null): Promise<boolean>;
}

export interface ReconcileReadOptions {
  /**
   * A list read (the home page, `/repurpose`): cheaper — a run already cutting
   * or reviewing its clips is left to its own page and its clip completions.
   */
  readonly forList?: boolean;
}

/**
 * What a run is actually doing when its stored status lags behind it: derived
 * from its source project (see `observe`). `failureCode` is set when the
 * derivation is a failure the reconciler has not written yet.
 */
interface Observation {
  readonly status: $Enums.RepurposeRunStatus;
  readonly failureCode: string | null;
}

/** How a request to start discovery ended. Never a throw: every outcome is recorded. */
export type DiscoveryStart =
  | { readonly outcome: "queued"; readonly jobId: string }
  /** A manual-mode run: no suggestions were asked for; it went straight to picking moments. */
  | { readonly outcome: "manual" }
  /** The run is past discovery, or stopped: nothing to start. */
  | { readonly outcome: "moved_on" }
  /**
   * Refused for now (the queue or the database is briefly down): the run keeps
   * waiting and the reconciler retries.
   */
  | { readonly outcome: "deferred" }
  /** Could not be started at all: the run now says `repurpose/highlights_failed`. */
  | { readonly outcome: "failed" };

function prismaCodeOf(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

/** A unique constraint refused the write (Prisma `P2002`). */
export function isUniqueViolation(error: unknown): boolean {
  return prismaCodeOf(error) === "P2002";
}

/**
 * Prisma codes for a database that is briefly unreachable or busy: cannot
 * reach it (P1001), timed out (P1002, P1008), closed the connection (P1017),
 * no free connection in the pool (P2024), a write conflict or deadlock (P2034).
 * Each clears on its own, which is what a local restart or a load spike on this
 * one-laptop API looks like.
 */
const TRANSIENT_DATABASE_CODES: ReadonlySet<string> = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2034",
]);

export function isTransientDatabaseError(error: unknown): boolean {
  const code = prismaCodeOf(error);
  return typeof code === "string" && TRANSIENT_DATABASE_CODES.has(code);
}

/** A refusal that means "not now", not "never": a full plan lane, a queue that is down. */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof AppException &&
    (error.httpStatus === HttpStatus.TOO_MANY_REQUESTS ||
      error.httpStatus === HttpStatus.SERVICE_UNAVAILABLE)
  );
}

/** `work` over `items`, at most `limit` at a time, results in order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line security/detect-object-injection -- index bounded by items.length
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** Reads a cancel makes of a run that keeps moving under it before it gives up. */
const CANCEL_ATTEMPTS = 3;

/**
 * Statuses a LIST read works out the step and bar for: the ones the server is
 * working through, which are the ones Home draws a bar for. A run waiting for
 * its person, or finished, is left to its own page.
 */
const LIST_ACTIVITY_STATUSES: ReadonlySet<$Enums.RepurposeRunStatus> = new Set([
  "acquiring",
  "preparing_media",
  "transcribing",
  "analyzing",
  "materializing",
  "rendering",
]);

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
  private reconciler: RunReconciler | undefined;

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
    /** YouTube's circuit breaker; absent in hand-built harnesses (fetches then always go). */
    @Optional() private readonly gate?: SourceGate,
    /** The step a run is on and its real progress (`run-activity.ts`); absent in harnesses. */
    @Optional() private readonly activity?: RunActivityReader,
  ) {}

  /** Called once, at boot, by `RepurposeReconciler` (see {@link RunReconciler}). */
  useReconciler(reconciler: RunReconciler): void {
    this.reconciler = reconciler;
  }

  /**
   * Reconcile one run now, for a completion or an event that just changed what
   * it stands on. Never throws: whatever called this has already done its own
   * work, and the next read of the run reconciles again anyway.
   */
  async reconcileRun(runId: string): Promise<void> {
    if (this.reconciler === undefined) return;
    try {
      const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
      if (run !== null) await this.reconciler.reconcile(run);
    } catch (error) {
      this.logger.warn({ runId, err: error }, "could not reconcile the run after a completion");
    }
  }

  /** A read's view of `run`, reconciled first when it is due. */
  private async reconciled(
    run: RepurposeRun,
    options: ReconcileReadOptions = {},
  ): Promise<RepurposeRun> {
    return this.reconciler === undefined ? run : this.reconciler.reconcileIfDue(run, options);
  }

  /**
   * For a completion that handed work on while the person was pressing Stop.
   * `cancel` stops the jobs that exist when it looks; a job queued a moment
   * after — the probe an acquisition's completion enqueues after reading the
   * run as live — would otherwise run on, through the proxy, to a paid
   * transcription of a video they stopped. Called once that work is queued, so
   * one of the two always sees the other.
   *
   * @returns whether the run is cancelled.
   */
  async stopIfCancelled(runId: string): Promise<boolean> {
    const run = await this.prisma.repurposeRun.findUnique({ where: { id: runId } });
    if (run === null || run.status !== "cancelled") return false;
    await this.stopRunJobs(run);
    return true;
  }

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

  /**
   * @param origin where the run comes from when it is not a person at the start
   *   form: a channel automation (`automations/source-watch.poller.ts`) starts
   *   its runs through this same path, so credits, plan limits, windows and
   *   lanes all apply, and passes the attestation its channel was connected
   *   under rather than claiming a fresh one now (2026-10-02).
   */
  async create(
    workspaceId: string,
    userId: string,
    input: CreateRunInput,
    origin: CreateRunOrigin = {},
  ): Promise<CreateRunResponse> {
    await this.assertAvailable(workspaceId);
    await this.assertEntitled(workspaceId);

    // Everything that can refuse, refuses BEFORE the project row exists. That is
    // the only ordering in which a refusal leaves nothing behind at all.
    const source = await this.resolveSource(workspaceId, input);
    await this.assertStyleExists(workspaceId, input.setup.caption.styleId);
    // A link starts downloading the moment the run exists, so how much of it to
    // process - and whether the balance pays for a minute of it - is settled
    // here too. An upload's length is only known once its probe has run, and
    // its transcription is refused for credits then, as any upload's is.
    const budget = source.normalizedUrl === null ? null : await this.acquisitionBudget(workspaceId);

    return this.startRun(workspaceId, userId, input, source, budget, origin);
  }

  /**
   * How much of a link this workspace may process now (2026-09-27): the plan's
   * window, cut to what the balance and the plan's enqueued-credit cap pay for
   * ({@link runWindowMs}). The balance is read the way a transcription's
   * reservation reads it (`credit_accounts.balance_tenths`, open holds already
   * off it), and the cap for the plan admission control uses, which is the
   * subscription's (`resolveWorkspacePlan`), not a week pass's.
   *
   * Nothing is reserved at this point - the transcription's hold is taken when
   * it is queued, after the download - so the workspace's OTHER link runs still
   * on their way to a transcription are counted off the balance first, each at
   * its worst case ({@link pendingTranscriptionTenths}). Without that, two links
   * pasted back to back on Free each saw 20 credits, each fetched 19:45, and the
   * second failed `no_credits` at transcription: the late failure this check
   * exists to prevent. Two creates in the same instant can still both pass, as
   * nothing is written until the run row; a real run-level hold is Phase 3.
   *
   * @param exceptRunId the run being fetched again (a retry), whose own earlier
   *   window is not a claim on the balance - this fetch replaces it.
   * @throws AppException 402 `repurpose/no_credits`, `{ creditsLeft }`, when not
   *   even a minute is affordable: better refused now than downloaded, prepared
   *   and then failed at transcription. `creditsLeft` is what is left for THIS
   *   run once the others are counted.
   */
  private async acquisitionBudget(
    workspaceId: string,
    exceptRunId?: string,
  ): Promise<AcquisitionBudget> {
    const [entitlement, plan, account, pendingTenths] = await Promise.all([
      this.entitlements.forWorkspace(workspaceId),
      resolveWorkspacePlan(this.prisma, workspaceId),
      this.prisma.creditAccount.findUnique({
        where: { workspaceId },
        select: { balanceTenths: true },
      }),
      this.pendingTranscriptionTenths(workspaceId, exceptRunId),
    ]);
    const limits = clipsLimitsFor(entitlement);
    const balanceTenths = account?.balanceTenths ?? 0;
    const availableTenths = balanceTenths - pendingTenths;
    const windowMs = runWindowMs({
      clipsWindowMs: limits.clipsWindowMs,
      balanceTenths: availableTenths,
      // eslint-disable-next-line security/detect-object-injection -- a PlanKey enum value from the database
      enqueuedCapTenths: PLAN_ENQUEUED_CAP_TENTHS[plan],
    });
    if (windowMs < MIN_WINDOW_MS) {
      const creditsLeft = creditsOf(availableTenths);
      throw new AppException(
        REPURPOSE_ERRORS.noCredits,
        pendingTenths > 0
          ? `Processing a video takes 1 credit a minute. This workspace has ${String(creditsOf(balanceTenths))} left, and the videos it is already fetching need ${String(creditsOf(pendingTenths))} of them. Add credits, or wait for those to finish.`
          : `Processing a video takes 1 credit a minute, and this workspace has ${String(creditsLeft)} left. Add credits to start it.`,
        HttpStatus.PAYMENT_REQUIRED,
        { creditsLeft },
      );
    }
    return { windowMs, limits };
  }

  /**
   * What the workspace's other link runs will still take from the balance for
   * their transcriptions, in tenths: every live run before its moments whose
   * source has neither a transcript nor a transcription job that is queued,
   * running or done (those already hold, or have spent, their credits - the
   * balance has them off already), at {@link pendingQuoteTenths}.
   *
   * One query when there are none, which is the usual case.
   */
  private async pendingTranscriptionTenths(
    workspaceId: string,
    exceptRunId?: string,
  ): Promise<number> {
    const runs = await this.prisma.repurposeRun.findMany({
      where: {
        workspaceId,
        sourceKind: { not: "upload" },
        status: { in: [...PRE_CANDIDATE_STATUSES] },
        ...(exceptRunId === undefined ? {} : { id: { not: exceptRunId } }),
      },
      select: { sourceProjectId: true },
    });
    if (runs.length === 0) return 0;
    const projectIds = [...new Set(runs.map((run) => run.sourceProjectId))];

    const [transcripts, transcriptions, media, downloads] = await Promise.all([
      this.prisma.transcript.findMany({
        where: { projectId: { in: projectIds } },
        select: { projectId: true },
      }),
      this.prisma.job.findMany({
        where: {
          projectId: { in: projectIds },
          type: { in: ["ai.transcribe", "ai.align"] },
          status: { in: ["queued", "running", "succeeded"] },
        },
        select: { projectId: true },
      }),
      this.prisma.mediaAsset.findMany({
        where: { projectId: { in: projectIds }, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: { projectId: true, status: true, durationMs: true },
      }),
      this.prisma.job.findMany({
        where: { projectId: { in: projectIds }, type: "media.acquire" },
        orderBy: { queuedAt: "desc" },
        select: { projectId: true, params: true },
      }),
    ]);

    const settled = new Set<string | null>([
      ...transcripts.map((row) => row.projectId),
      ...transcriptions.map((row) => row.projectId),
    ]);
    // Newest first, so the first row seen per project is the one that counts.
    const newestMedia = new Map<string, (typeof media)[number]>();
    for (const row of media) {
      if (!newestMedia.has(row.projectId)) newestMedia.set(row.projectId, row);
    }
    const newestWindow = new Map<string, number | null>();
    for (const job of downloads) {
      if (job.projectId === null || newestWindow.has(job.projectId)) continue;
      const payload = MediaAcquirePayloadSchema.safeParse(job.params);
      newestWindow.set(
        job.projectId,
        payload.success ? (payload.data.window?.maxMs ?? null) : null,
      );
    }

    let tenths = 0;
    for (const projectId of projectIds) {
      if (settled.has(projectId)) continue;
      const row = newestMedia.get(projectId);
      tenths += pendingQuoteTenths({
        mediaStatus: row?.status ?? null,
        mediaDurationMs: row?.durationMs ?? null,
        windowMaxMs: newestWindow.get(projectId) ?? null,
      });
    }
    return tenths;
  }

  /**
   * Make the run: its source project, its row, and for a link its download.
   * Shared by `create` and `nextWindow`, which have already refused whatever
   * they refuse; everything past the project is compensated.
   */
  private async startRun(
    workspaceId: string,
    userId: string,
    input: CreateRunInput,
    source: ResolvedSource,
    budget: AcquisitionBudget | null,
    origin: {
      /**
       * The attestation the source was fetched under, when it is not this
       * request's: when, by whom, and where it was given - a run's id, or
       * `watch:<id>` for the channel automation it was ticked on.
       */
      readonly attestation?: {
        readonly at: Date;
        readonly by: string | null;
        readonly of: string;
      };
      /** The run whose next window this is (`POST .../next-window`). */
      readonly nextWindowOf?: string;
      /** The source's length, when an earlier run of it measured it. */
      readonly sourceDurationMs?: number;
    } = {},
  ): Promise<CreateRunResponse> {
    const runId = ulid();
    const window: WindowRequest = {
      ...windowRequestOf(input.setup.window),
      ...(origin.sourceDurationMs === undefined
        ? {}
        : { sourceDurationMs: origin.sourceDurationMs }),
    };

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
            : {
                rightsAttestedAt: origin.attestation?.at ?? new Date(),
                rightsAttestedBy: origin.attestation === undefined ? userId : origin.attestation.by,
              }),
          // What the download is asked for. A picked start is part of the
          // live-source key (`repurpose_runs_live_source_idx`), which is what
          // lets the next window of a video run beside the first.
          ...(budget === null
            ? {}
            : {
                windowPolicy: window.policy,
                ...(window.startMs === undefined ? {} : { windowStartMs: window.startMs }),
              }),
          mode: input.setup.discovery.mode,
          status: "draft",
          currentStage: "getting_video",
          requestedCandidates: input.setup.discovery.requestedCandidates,
          configVersion: 1,
          config: {
            schemaVersion: 1,
            sourceLanguage: input.setup.sourceLanguage,
            caption: { ...input.setup.caption, styleVersion: 1 },
            // With its steering (2026-09-29); a length preset is written into
            // the bounds too (`withLengthPreset`).
            discovery: withLengthPreset(input.setup.discovery),
            // Autopilot (`automationOf`): absent reads as manual, as every
            // run from before it was.
            automation: input.setup.automation ?? "manual",
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
        acquireJobId = await this.startAcquisition(
          workspaceId,
          project,
          run,
          {
            kind: source.kind,
            fingerprint: source.fingerprint,
            normalizedUrl: source.normalizedUrl,
          },
          budget ?? (await this.acquisitionBudget(workspaceId)),
          window,
        );
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
      // Two creates for one link at once: `resolveSource`'s check passed for
      // both and `repurpose_runs_live_source_idx` refused the second. That is
      // the same refusal in our own words, not a raw database conflict.
      if (isUniqueViolation(error) && source.fingerprint !== null) {
        throw (
          (await this.duplicateOf(workspaceId, source.fingerprint, undefined, window.startMs)) ??
          error
        );
      }
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
        ...(budget === null
          ? {}
          : {
              windowMs: budget.windowMs,
              windowPolicy: window.policy,
              ...(window.startMs === undefined ? {} : { windowStartMs: window.startMs }),
            }),
        ...(origin.nextWindowOf === undefined ? {} : { nextWindowOf: origin.nextWindowOf }),
        // A fetch under someone else's attestation says so: the actor above is
        // who asked for this run, these are who attested to the video and where.
        ...(origin.attestation === undefined
          ? {}
          : {
              rightsAttestedBy: origin.attestation.by,
              rightsAttestedAt: origin.attestation.at.toISOString(),
              rightsAttestationOf: origin.attestation.of,
            }),
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
   *
   * @param options.checkDuplicate false for `nextWindow`, which looks for the
   *   run of its own window itself and answers with it rather than refusing.
   */
  private async resolveSource(
    workspaceId: string,
    input: CreateRunInput,
    options: { readonly checkDuplicate?: boolean } = {},
  ): Promise<ResolvedSource> {
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

    if (options.checkDuplicate !== false) {
      const duplicate = await this.duplicateOf(
        workspaceId,
        parsed.source.sourceFingerprint,
        undefined,
        input.setup.window?.startMs,
      );
      if (duplicate !== null) throw duplicate;
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
   * The refusal for a link that already has a live run — with that run's id, so
   * the page can open it rather than leave the person locked out of their own
   * link. A finished run (`review_ready`) is still live to
   * `repurpose_runs_live_source_idx`, so "open the one you have" is the only
   * useful answer.
   *
   * Windows (2026-09-27): a run that asked for no particular start collides
   * with any live run of the video - pasting a link twice is still one
   * request. A run over a picked start (`windowStartMs`, "process the next 20
   * minutes") collides only with a live run at that same start, or one whose
   * start is not known (still downloading, or the whole video): it may run
   * beside the window before it.
   *
   * Public because a retry's reopen can lose the same race `create` can, and
   * answers it with the same refusal (`RepurposeReconciler.reopen`).
   */
  async duplicateOf(
    workspaceId: string,
    fingerprint: string,
    exceptRunId?: string,
    windowStartMs?: number | null,
  ): Promise<AppException | null> {
    const live = await this.prisma.repurposeRun.findFirst({
      where: {
        workspaceId,
        sourceFingerprint: fingerprint,
        status: { notIn: ["published", "failed", "cancelled"] },
        ...(exceptRunId === undefined ? {} : { id: { not: exceptRunId } }),
        ...(typeof windowStartMs === "number"
          ? { OR: [{ windowStartMs }, { windowStartMs: null }] }
          : {}),
      },
      select: { id: true },
    });
    if (live === null) return null;
    return new AppException(
      REPURPOSE_ERRORS.sourceDuplicate,
      "You are already working on this video.",
      HttpStatus.CONFLICT,
      { existingRunId: live.id },
    );
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
   *
   * Windows (2026-09-27): `limits.maxDurationMs` is the plan's source CEILING
   * (12 h), not its allowance, and `window` says how much of a longer source to
   * take and from where. A source within the window is fetched whole, exactly
   * as before. The timeout grows with the window (`acquireTimeoutMs`).
   *
   * **Deploy the acquire worker that reads `window` before this API.** An older
   * worker never looks at `window`, so it now fetches whole videos up to that
   * 12-hour ceiling and the plan's byte cap - hours of bandwidth and disk, and
   * YouTube's rate limit - only for the probe to refuse each one as longer than
   * its window (`probe.handler.ts`). The API cannot tell which worker takes the
   * job, so the order of the deploy is the only guard.
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
    budget: AcquisitionBudget,
    window: WindowRequest,
    /**
     * A fetch after the first (a retry, or the reconciler replacing one whose
     * enqueue was refused). Its job key names the media row it fetches into, so
     * each attempt is its own job — the first one's key stays as it always was
     * — and two callers restarting the same row still collapse to one job.
     * `into` is a pending row to reuse; without it a fresh row is reserved.
     */
    refetch?: {
      readonly into?: {
        readonly id: string;
        readonly bucket: $Enums.StorageBucket;
        readonly storageKey: string;
      };
    },
  ): Promise<string | null> {
    const { limits } = budget;
    // A picked start over a source whose length is known is cut to what is left
    // of it (`acquireWindowMaxMs`). The length comes with the request when the
    // caller has it (the next window, a retry of a landed run), else from any
    // earlier run of the same video in this workspace.
    const measured =
      window.policy === "range" &&
      window.startMs !== undefined &&
      window.startMs > 0 &&
      window.sourceDurationMs === undefined
        ? await this.measuredSourceDurationMs(workspaceId, source.fingerprint)
        : null;
    const maxMs = acquireWindowMaxMs(
      budget.windowMs,
      measured === null ? window : { ...window, sourceDurationMs: measured },
    );
    let target = refetch?.into;
    if (target === undefined) {
      const reserved = await this.media.reserveAcquisition(project, {
        filename: ACQUIRED_FILENAME,
        mime: ACQUIRED_MIME,
      });
      target = { id: reserved.media.id, bucket: reserved.bucket, storageKey: reserved.key };
    }

    // Parsed, not assembled: the contract is the wire format both runtimes agree
    // on, so building the object and hoping is not good enough (§8.1).
    const payload = MediaAcquirePayloadSchema.parse({
      schemaVersion: REPURPOSE_SCHEMA_VERSION,
      runId: run.id,
      projectId: project.id,
      mediaId: target.id,
      source: {
        kind: source.kind === "youtube_url" ? "youtube_url" : "direct_media_url",
        normalizedUrl: source.normalizedUrl,
        sourceId: source.fingerprint,
      },
      destination: { bucket: target.bucket, key: target.storageKey },
      limits: {
        maxBytes: Math.min(limits.maxFileBytes, ACQUIRE_MAX_BYTES),
        maxDurationMs: Math.min(limits.maxSourceDurationMs, ACQUIRE_MAX_DURATION_MS),
        timeoutMs: acquireTimeoutMs(maxMs),
      },
      window: {
        maxMs,
        policy: window.policy,
        ...(window.startMs === undefined ? {} : { startMs: window.startMs }),
      },
    });

    // YouTube refused this machine a moment ago (`SourceGate`): the row is
    // reserved and waits, nothing is queued, and the reconciler fetches into it
    // once the gate lets a fetch through. Not a refusal of the run.
    if (source.kind === "youtube_url" && this.gate !== undefined && !(await this.gate.mayFetch())) {
      this.logger.log(
        { runId: run.id, mediaId: target.id },
        "YouTube is refusing downloads; this fetch waits for the source gate",
      );
      return null;
    }

    const firstKey = mediaAcquireJobKey(run.id, source.fingerprint ?? run.id);
    const enqueued = await this.jobs.enqueue({
      type: "media.acquire",
      workspaceId,
      projectId: project.id,
      params: payload,
      jobKey: refetch === undefined ? firstKey : `${firstKey}:${target.id}`,
      worstCaseTenths: ACQUIRE_QUOTE_TENTHS,
      reason: `media.acquire · ${run.id}`,
    });
    return enqueued.job.id;
  }

  /**
   * The length an earlier download of this video in this workspace reported
   * (`repurpose_runs.source_duration_ms`), newest first; null when none has.
   */
  private async measuredSourceDurationMs(
    workspaceId: string,
    fingerprint: string | null,
  ): Promise<number | null> {
    if (fingerprint === null) return null;
    const earlier = await this.prisma.repurposeRun.findFirst({
      where: { workspaceId, sourceFingerprint: fingerprint, sourceDurationMs: { not: null } },
      orderBy: { updatedAt: "desc" },
      select: { sourceDurationMs: true },
    });
    const measured = earlier?.sourceDurationMs;
    return typeof measured === "number" && measured > 0 ? measured : null;
  }

  /**
   * Fetch a link run's source again, from the address an earlier fetch carried
   * (the run row never keeps it, §17.4). The plan's limits are resolved afresh,
   * so a person who upgraded after "too large for your plan" gets the new cap.
   *
   * The window is worked out afresh too, over the start the run asked for
   * (`windowRequestOfRun`): a run from before windows existed that failed
   * "too long for your plan" now fetches a window of the video, which fits.
   *
   * @param into a pending media row nothing is fetching into; omitted, a fresh
   *   row is reserved and becomes the source's newest media.
   * @returns the job id, or null when YouTube is refusing downloads and the
   *   fetch waits for the source gate (the row is reserved all the same).
   * @throws when links are switched off for the workspace, when the balance no
   *   longer pays for a minute (402 `repurpose/no_credits`), or the enqueue is refused.
   */
  async reacquire(
    run: RepurposeRun,
    normalizedUrl: string,
    into?: {
      readonly id: string;
      readonly bucket: $Enums.StorageBucket;
      readonly storageKey: string;
    },
  ): Promise<string | null> {
    if (!(await this.flagEnabled(run.workspaceId, REPURPOSE_FLAGS.youtubeAcquire))) {
      throw new AppException(
        REPURPOSE_ERRORS.sourceUnsupported,
        "Links are not available yet. Upload the video file instead.",
        HttpStatus.BAD_REQUEST,
      );
    }
    const project = await this.prisma.project.findFirst({
      where: { id: run.sourceProjectId, workspaceId: run.workspaceId, deletedAt: null },
      select: { id: true, workspaceId: true, status: true },
    });
    if (project === null) {
      throw new AppException(
        REPURPOSE_ERRORS.notRetryable,
        "This video's project was deleted. Start a new video with the link.",
        HttpStatus.CONFLICT,
      );
    }
    // This run's own earlier window is not a claim on the balance: this fetch
    // replaces it.
    const budget = await this.acquisitionBudget(run.workspaceId, run.id);
    return this.startAcquisition(
      run.workspaceId,
      project,
      run,
      { kind: run.sourceKind, fingerprint: run.sourceFingerprint, normalizedUrl },
      budget,
      windowRequestOfRun(run),
      into === undefined ? {} : { into },
    );
  }

  /**
   * "Process the next window" (2026-09-27): a NEW run over the same video,
   * starting where this run's window ended, with this run's settings. The
   * window's length is worked out afresh (plan, balance), and admission applies
   * as for any run.
   *
   * Idempotent: pressed twice, or from two tabs, the live run already over that
   * start is the answer, not a second download.
   *
   * @throws 409 `repurpose/no_next_window` when there is nothing after this
   *   window: a source processed whole, a section that has not landed yet, an
   *   upload, or less than {@link NEXT_WINDOW_MIN_MS} left.
   * @throws 402 `repurpose/no_credits` when the balance does not pay for a minute.
   */
  async nextWindow(
    workspaceId: string,
    userId: string,
    runId: string,
  ): Promise<NextWindowResponse> {
    await this.assertAvailable(workspaceId);
    const run = await this.require(workspaceId, runId);

    const url = youtubeWatchUrl(run.sourceKind, run.sourceFingerprint);
    if (url === null) {
      throw noNextWindow("Only a YouTube link can be processed a part at a time.");
    }
    const window = windowView(run);
    if (window === null) {
      // "Still being fetched" only while it is: a run from before windows, one
      // processed whole, and one whose section was not recorded (it lost the
      // start to another live run of the video) all have no part to continue
      // from, however long ago they finished.
      throw noNextWindow(
        (await this.isFetching(run))
          ? "This video is still being fetched. Try again once it has arrived."
          : "This run has no recorded part of the video to continue from: it covered all of it, or started before parts were recorded. Paste the link again to choose a start.",
      );
    }
    if (!nextWindowAvailable(run)) {
      throw noNextWindow(
        `There is nothing left after ${formatClock(window.endMs)} of this ${formatClock(window.sourceDurationMs)} video.`,
      );
    }
    const startMs = window.endMs;

    const existing = await this.liveRunAt(workspaceId, run.sourceFingerprint, startMs);
    if (existing !== null) return { run: await this.get(workspaceId, existing) };

    // This run's own settings, through the same schema a create goes through:
    // the frozen config carries a `styleVersion` the request does not, and the
    // parse drops it and fills in anything an older run never recorded.
    const config = (run.config as Record<string, unknown> | null) ?? {};
    const parsed = createRunSchema.safeParse({
      source: { kind: "url", url, rightsAttested: true },
      setup: {
        sourceLanguage:
          typeof config["sourceLanguage"] === "string" ? config["sourceLanguage"] : "auto",
        caption: config["caption"],
        discovery: config["discovery"] ?? { mode: run.mode },
        window: { startMs },
        // The next part runs the way this one did.
        automation: automationOf(run),
      },
    });
    if (!parsed.success) {
      // Only a row older than its own schema gets here; a 500 would say nothing.
      this.logger.warn(
        { runId: run.id, issues: parsed.error.issues.slice(0, 3) },
        "a run's frozen settings no longer make a valid run",
      );
      throw noNextWindow("This video's settings cannot start another part. Paste the link again.");
    }
    const input = parsed.data;

    // The style is not checked against today's catalogue: it is the one this
    // video's first window was made with, and the next should look the same.
    const source = await this.resolveSource(workspaceId, input, { checkDuplicate: false });
    const budget = await this.acquisitionBudget(workspaceId);
    try {
      const created = await this.startRun(workspaceId, userId, input, source, budget, {
        // The same video, fetched under the attestation its first window was
        // made with. The row keeps who attested and when - recording the
        // person who pressed "next" as having attested would put a statement
        // in their name that they never made - and the audit event names both:
        // its actor is who pressed, and it says whose attestation was relied on.
        ...(run.rightsAttestedAt === null
          ? {}
          : { attestation: { at: run.rightsAttestedAt, by: run.rightsAttestedBy, of: run.id } }),
        nextWindowOf: run.id,
        // What is left of the video is known now, and the download is cut to it.
        sourceDurationMs: window.sourceDurationMs,
      });
      return { run: created.run };
    } catch (error) {
      // Lost a race to another press: the run that won is the answer.
      if (error instanceof AppException && error.code === REPURPOSE_ERRORS.sourceDuplicate) {
        const winner = await this.liveRunAt(workspaceId, run.sourceFingerprint, startMs);
        if (winner !== null) return { run: await this.get(workspaceId, winner) };
      }
      throw error;
    }
  }

  /**
   * Whether a link run's download is still under way: live, and its source not
   * landed yet (no media row, or one still pending). The stored status never
   * moves past `draft` on its own, so it is read the way the page reads it.
   */
  private async isFetching(run: RepurposeRun): Promise<boolean> {
    if (run.sourceKind === "upload") return false;
    if (!["draft", "acquiring"].includes(run.status)) return false;
    const observed = (await this.observe(run))?.status ?? run.status;
    return observed === "draft" || observed === "acquiring";
  }

  /** The live run of this video over exactly this start, if there is one. */
  private async liveRunAt(
    workspaceId: string,
    fingerprint: string | null,
    windowStartMs: number,
  ): Promise<string | null> {
    if (fingerprint === null) return null;
    const live = await this.prisma.repurposeRun.findFirst({
      where: {
        workspaceId,
        sourceFingerprint: fingerprint,
        windowStartMs,
        status: { notIn: ["published", "failed", "cancelled"] },
      },
      select: { id: true },
    });
    return live?.id ?? null;
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
    // The home page's banner is a list read, and the only thing looking at a run
    // the person has navigated away from — so a list read reconciles too
    // (throttled per run, and never a finished one), or a run that stalled
    // behind a closed tab would never move. A few runs at a time, not the whole
    // page at once: see `LIST_RECONCILE_CONCURRENCY`.
    //
    // Then the same derivation `get()` uses, and for the same reason: without
    // it, a run whose transcript already exists still reads "Add a video to get
    // started" on any list view, because nothing writes `status` past `draft`
    // for these early stages (see `observe`). The home page pipeline banner is
    // a list view, so it needs this exactly as much as the run's own page.
    const views = await mapLimited(page, LIST_RECONCILE_CONCURRENCY, async (run) => {
      const current = await this.reconciled(run, { forList: true });
      const observed = await this.observe(current);
      // The home page's bar is a list read too: a run the server is working on
      // gets its real progress there, the same as on its own page.
      const status = observed?.status ?? current.status;
      const activity = LIST_ACTIVITY_STATUSES.has(status)
        ? await this.activity?.forRun(current, {
            status,
            candidateCount: run._count.candidates,
            sourceBusyUntil: null,
          })
        : undefined;
      return { current, observed, activity };
    });
    return {
      items: views.map((view, index) =>
        this.toView(
          view.current,
          {
            // eslint-disable-next-line security/detect-object-injection -- index bounded by views.map
            candidateCount: page[index]?._count.candidates ?? 0,
            // eslint-disable-next-line security/detect-object-injection -- as above
            clipCount: page[index]?._count.clips ?? 0,
            variantCount: 0,
          },
          view.observed,
          undefined,
          null,
          view.activity,
        ),
      ),
      nextCursor: runs.length > input.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async get(workspaceId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    const run = await this.reconciled(await this.require(workspaceId, runId));
    const counts = await this.counts(run.id);
    const observed = await this.observe(run);
    const waitingFor = await this.waitingFor(run, observed);
    return this.toView(
      run,
      counts,
      observed,
      await this.retryPossible(run, observed),
      waitingFor,
      await this.activity?.forRun(run, {
        status: observed?.status ?? run.status,
        candidateCount: counts.candidateCount,
        sourceBusyUntil: waitingFor === null ? null : Date.parse(waitingFor.until),
      }),
    );
  }

  /**
   * A link run still getting its video while YouTube is refusing this server
   * (`SourceGate`): it waits, and continues by itself at `until`. Only the
   * run's own view asks; a list shows the run as getting its video.
   */
  private async waitingFor(
    run: RepurposeRun,
    observed: Observation | null,
  ): Promise<RunView["waitingFor"]> {
    const status = observed?.status ?? run.status;
    if (run.sourceKind === "upload" || this.gate === undefined) return null;
    if (status !== "draft" && status !== "acquiring") return null;
    const { openUntil } = await this.gate.state();
    return openUntil === null
      ? null
      : { reason: "source_busy", until: new Date(openUntil).toISOString() };
  }

  /**
   * How many of this run's downloads YouTube refused (`media/source_blocked`).
   * Up to {@link MAX_BLOCKED_FETCHES} the run waits out the source gate and
   * fetches again by itself; past it, the refusal is the run's failure.
   */
  async blockedFetches(run: Pick<RepurposeRun, "id" | "workspaceId">): Promise<number> {
    return this.prisma.job.count({
      where: {
        workspaceId: run.workspaceId,
        type: "media.acquire",
        jobKey: { startsWith: `media.acquire:${run.id}:` },
        status: "failed",
        error: { path: ["code"], equals: SOURCE_BLOCKED_REASON },
      },
    });
  }

  /**
   * For a run shown as failed: whether "Try again" would restart anything
   * (`RepurposeReconciler.retryPossible`, the same plan the retry follows).
   * Undefined — the status alone decides — for any other run, or when that
   * cannot be read right now: a database blink should not take the button
   * away from a run a retry would restart.
   *
   * Only the run's own view asks. A list does not draw the error card, and a
   * snapshot per failed run on every home-page poll is not worth it.
   */
  private async retryPossible(
    run: RepurposeRun,
    observed: Observation | null,
  ): Promise<boolean | undefined> {
    const status = observed?.status ?? run.status;
    if (!isRetryable(status) || this.reconciler === undefined) return undefined;
    try {
      return await this.reconciler.retryPossible(run, observed?.failureCode ?? run.failureCode);
    } catch (error) {
      this.logger.warn(
        { runId: run.id, err: error },
        "could not work out whether a retry would run",
      );
      return undefined;
    }
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
   *
   * A source media that FAILED is a failure, never "Add a video to get started"
   * (2026-09-26): the reconciler writes it to the run on the next pass, and a
   * read that lands before that pass says the same thing it will.
   */
  private async observe(run: RepurposeRun): Promise<Observation | null> {
    // Only the earliest stages are derivable; from `analyzing` on, discovery
    // and the clips own the status and write it themselves.
    if (!["draft", "acquiring", "preparing_media", "transcribing"].includes(run.status)) {
      return null;
    }

    const [media, transcript] = await Promise.all([
      this.prisma.mediaAsset.findFirst({
        where: { projectId: run.sourceProjectId, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          failureReason: true,
          uploadedAt: true,
          audio16kKey: true,
          hasAudio: true,
          durationMs: true,
        },
      }),
      this.prisma.transcript.findFirst({
        where: { projectId: run.sourceProjectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
    ]);

    const as = (status: $Enums.RepurposeRunStatus): Observation => ({ status, failureCode: null });
    if (transcript !== null) return as("analyzing");
    if (media === null) return null;
    switch (media.status) {
      case "pending":
      case "uploading":
        return as(run.sourceKind === "upload" ? "draft" : "acquiring");
      case "uploaded":
      case "probing":
        // The transcription already running on the audio written back ahead
        // of the video encode (W5) is what the person is waiting for.
        return as((await this.transcribingEarly(run, media)) ? "transcribing" : "preparing_media");
      case "ready":
        // Media is ready and no transcript exists yet: it is being made, or the
        // reconciler is about to start it (or fail the run for want of credits).
        return as("transcribing");
      case "failed":
        // YouTube refused the download, and the run waits the refusal out and
        // fetches again by itself (`SourceGate`): still getting the video.
        if (
          run.sourceKind !== "upload" &&
          media.uploadedAt === null &&
          media.failureReason === SOURCE_BLOCKED_REASON &&
          (await this.blockedFetches(run)) < MAX_BLOCKED_FETCHES
        ) {
          return as("acquiring");
        }
        return {
          status: "failed",
          failureCode: runFailureCode({
            failedAt:
              run.sourceKind !== "upload" && media.uploadedAt === null ? "acquire" : "processing",
            mediaReason: media.failureReason,
          }),
        };
      default:
        return null;
    }
  }

  /** A first transcription is in flight on `media`'s early audio. */
  private async transcribingEarly(
    run: RepurposeRun,
    media: {
      readonly id: string;
      readonly status: $Enums.MediaStatus;
      readonly audio16kKey: string | null;
      readonly hasAudio: boolean | null;
      readonly durationMs: number | null;
    },
  ): Promise<boolean> {
    if (!audioReadyEarly(media)) return false;
    const live = await this.prisma.job.findFirst({
      where: {
        projectId: run.sourceProjectId,
        type: "ai.transcribe",
        jobKey: firstTranscriptionJobKey(run.sourceProjectId, media.id),
        status: { in: ["queued", "running"] },
      },
      select: { id: true },
    });
    return live !== null;
  }

  async cancel(workspaceId: string, userId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    let run = await this.require(workspaceId, runId);

    // Conditional on the status it was read in, like every other writer of a
    // run: a failure or a completion that lands between the read and this write
    // is the real answer, and a blind write turned a run that had just failed
    // into a cancelled one and lost its code. A run that moved on and can still
    // be stopped is read again and stopped where it now is.
    for (let attempt = 1; ; attempt += 1) {
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
      const observed = await this.observe(run);
      const { count } = await this.prisma.repurposeRun.updateMany({
        where: { id: run.id, status: run.status },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          // The stage it stopped on is kept, so the rail can still show where.
          currentStage: stageForStatus(observed?.status ?? run.status),
        },
      });
      if (count > 0) break;
      if (attempt >= CANCEL_ATTEMPTS) {
        // Moving under us on every read: not something a person can do anything
        // about but ask again.
        throw new AppException(
          REPURPOSE_ERRORS.notCancellable,
          "This run is changing right now. Try stopping it again in a moment.",
          HttpStatus.CONFLICT,
        );
      }
      run = await this.require(workspaceId, runId);
    }
    const cancelled = await this.require(workspaceId, runId);

    await this.audit.record({
      action: "repurpose.run.cancelled",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      data: { fromStatus: run.status },
    });
    await this.publishStage(cancelled);
    // After the run reads `cancelled`, so each cancelled job's failure handler
    // finds a stopped run and leaves it as it is.
    await this.stopRunJobs(cancelled);

    // Completed artefacts are deliberately left alone: cancelling stops future
    // work, it does not delete what the person already has (§4.2).
    return this.toView(cancelled, await this.counts(run.id));
  }

  /**
   * "Nothing else will happen" has to be true: the download, the probe and
   * proxy of the source, the transcription (the step that spends credits) and
   * discovery still in flight for this run are cancelled, which releases their
   * credit holds and their lane. Best effort — a job that finishes in the
   * meantime answers 409; a download or a discovery that lands anyway is turned
   * away by its completion handler, which checks for a stopped run.
   *
   * The probe and proxy matter because a proxy's success is what starts the
   * transcription (`MediaProxyCompletionHandler` → `AutoTranscribeTrigger`),
   * with no look at the run: a Stop pressed while the video was still being
   * prepared used to start a paid transcription minutes later. A cancelled job's
   * late completion is answered `already_completed` before any handler runs.
   *
   * Clip cuts are left to finish: a clip the person asked for is theirs, and a
   * cancelled run keeps what it already made.
   */
  private async stopRunJobs(run: RepurposeRun): Promise<void> {
    const live = await this.prisma.job.findMany({
      where: {
        workspaceId: run.workspaceId,
        status: { in: ["queued", "running"] },
        OR: [
          { type: "media.acquire", jobKey: { startsWith: `media.acquire:${run.id}:` } },
          { type: "ai.highlights", jobKey: { startsWith: `ai.highlights:${run.id}:` } },
          // Every run makes its own source project, so these touch no one else's.
          { type: { in: ["media.probe", "media.proxy"] }, projectId: run.sourceProjectId },
          { type: "ai.transcribe", projectId: run.sourceProjectId },
        ],
      },
      select: { id: true, type: true },
    });
    await this.cancelJobs(
      run,
      live.map((job) => job.id),
    );
  }

  /**
   * Cancel these jobs of `run`, one by one, which releases their credit holds
   * and their plan-lane slots (`JobsService.cancel`). Best effort: a job that
   * finished in the meantime answers 409, and a completion that lands anyway is
   * turned away by its handler. Public for the reconciler, which cancels a
   * run's stalled jobs once it has failed the run for them, and before a retry
   * starts the stage again.
   */
  async cancelJobs(run: RepurposeRun, jobIds: readonly string[]): Promise<void> {
    for (const jobId of jobIds) {
      try {
        await this.jobs.cancel(jobId, run.workspaceId);
      } catch (error) {
        this.logger.warn(
          { runId: run.id, jobId, status: run.status, err: error },
          "could not cancel a job of the run; its completion is turned away",
        );
      }
    }
  }

  /**
   * "Try again" runs the stage that failed again (§3): fetches the link again,
   * restarts the transcription, or looks for moments again — whichever the
   * durable state says is missing (`RepurposeReconciler.redrive`). It used to
   * set the run back to `draft` and enqueue nothing, so the run said "in
   * progress" forever and also locked its link.
   *
   * A refusal that only means "not now" (a full plan lane) leaves the run open
   * for the reconciler to finish; the answer is the run as it now stands.
   */
  async retry(workspaceId: string, userId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    // Looked up first: another workspace's run is a 404 whatever else is true.
    const found = await this.require(workspaceId, runId);
    const reconciler = this.reconciler;
    if (reconciler === undefined) {
      // Only reachable in a harness that never booted the module.
      throw new Error("RepurposeService.retry needs the run reconciler, which is not registered");
    }
    // A failure the durable state already shows (a failed download the
    // throttled read has not written yet) is one the person can retry now.
    const run = await reconciler.reconcile(found);

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
    // Window-aware: the next window of the same video, running meanwhile, does
    // not stop this one being tried again (`duplicateOf`).
    if (run.sourceFingerprint !== null) {
      const duplicate = await this.duplicateOf(
        workspaceId,
        run.sourceFingerprint,
        run.id,
        run.windowStartMs,
      );
      if (duplicate !== null) throw duplicate;
    }

    const retried = await reconciler.redrive(run);

    await this.audit.record({
      action: "repurpose.run.retried",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      data: {
        fromStage: run.currentStage,
        fromFailureCode: run.failureCode,
        toStatus: retried.status,
      },
    });

    // Usually open again, but a retry can fail the run straight back (no
    // credits for the transcription it restarted), and that view must not
    // offer a retry the next press would refuse either.
    const observed = await this.observe(retried);
    return this.toView(
      retried,
      await this.counts(run.id),
      observed,
      await this.retryPossible(retried, observed),
    );
  }

  /**
   * "Upload the file instead" (clips Wave B, 2026-09-27): a link run whose
   * video never arrived - YouTube refused this machine, the video is private
   * or removed, or it is still waiting for the source gate - becomes an upload
   * run over the same source project, so the person's settings, and the run
   * page they are on, carry on with a file from their own disk.
   *
   * The browser then uploads through its ordinary queue into
   * `sourceProjectId` (which calls `media/init` itself, as a new upload run
   * does), and the reconciler takes the run from there like any upload.
   *
   * Only while nothing of the video exists: the media rows the downloads
   * reserved have no bytes, and are removed so that the file uploaded next is
   * the source's only primary media. A download that is running right now is
   * not interrupted (it may be about to land); one still queued is cancelled.
   *
   * @throws 409 `repurpose/source_not_replaceable` for an upload run, a run
   *   that has its video (or moments), or one whose download is running.
   */
  async useUpload(workspaceId: string, userId: string, runId: string): Promise<RunView> {
    await this.assertAvailable(workspaceId);
    const found = await this.require(workspaceId, runId);
    const run = await this.reconciled(found);
    const notReplaceable = (message: string) =>
      new AppException(REPURPOSE_ERRORS.sourceNotReplaceable, message, HttpStatus.CONFLICT);

    if (run.sourceKind === "upload") {
      throw notReplaceable("This run is already waiting for an upload.");
    }
    if (!(
      (PRE_CANDIDATE_STATUSES as readonly string[]).includes(run.status) || run.status === "failed"
    )) {
      throw notReplaceable("This run already has its video.");
    }
    const [media, transcript, candidates] = await Promise.all([
      this.prisma.mediaAsset.findMany({
        where: { projectId: run.sourceProjectId, role: "primary" },
        select: { id: true, status: true, uploadedAt: true },
      }),
      this.prisma.transcript.count({ where: { projectId: run.sourceProjectId } }),
      this.prisma.clipCandidate.count({ where: { runId: run.id } }),
    ]);
    if (
      transcript > 0 ||
      candidates > 0 ||
      media.some(
        (row) =>
          row.uploadedAt !== null || !["pending", "uploading", "failed"].includes(row.status),
      )
    ) {
      throw notReplaceable("This run already has its video.");
    }
    const downloads = await this.prisma.job.findMany({
      where: {
        workspaceId,
        type: "media.acquire",
        jobKey: { startsWith: `media.acquire:${run.id}:` },
        status: { in: ["queued", "running"] },
      },
      select: { id: true, status: true },
    });
    if (downloads.some((job) => job.status === "running")) {
      throw notReplaceable(
        "The video is downloading right now. Wait for it, or stop this run and upload the file in a new one.",
      );
    }

    // The run first: a queued download cancelled below reports to a run that
    // is an upload by then, and its failure handler leaves it alone.
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: { id: run.id, status: run.status, sourceKind: run.sourceKind },
      data: {
        sourceKind: "upload",
        // No longer a download of that video: the live-source key is freed,
        // and the link can be started again elsewhere.
        sourceFingerprint: null,
        status: "draft",
        failureCode: null,
        failureDetail: Prisma.DbNull,
        completedAt: null,
        currentStage: stageForStatus("draft"),
        progress: progressForStatus("draft"),
        windowPolicy: null,
        windowStartMs: null,
        windowEndMs: null,
      },
    });
    if (count === 0) throw notReplaceable("This run changed a moment ago. Refresh the page.");
    await this.cancelJobs(
      run,
      downloads.map((job) => job.id),
    );
    // Rows with no bytes behind them: the refused downloads' reservations.
    await this.prisma.mediaAsset.deleteMany({
      where: {
        projectId: run.sourceProjectId,
        role: "primary",
        uploadedAt: null,
        status: { in: ["pending", "uploading", "failed"] },
      },
    });

    const converted = (await this.prisma.repurposeRun.findUnique({ where: { id: run.id } })) ?? run;
    await this.audit.record({
      action: "repurpose.run.source_replaced",
      resource: "repurpose_run",
      resourceId: run.id,
      actorId: userId,
      workspaceId,
      data: { from: run.sourceKind, fromStatus: run.status, fromFailureCode: run.failureCode },
    });
    await this.publishStage(converted);
    return this.toView(converted, await this.counts(run.id), await this.observe(converted));
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
  async publishStage(
    run: RepurposeRun,
    extras: { readonly candidateCount?: number } = {},
  ): Promise<void> {
    const projection = projectRun({ ...run, ...extras });
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
    observed: Observation | null = null,
    /**
     * Whether a retry would restart anything ({@link retryPossible}). Only ever
     * narrows the projection's answer; undefined leaves it to the status.
     */
    retryPossible?: boolean,
    /** What is holding the run, when something is ({@link waitingFor}). */
    waitingFor: RunView["waitingFor"] = null,
    /**
     * The step under way and the bar it fills (`RunActivityReader`): only the
     * reads that ask for it. Without it the bar is the status's own number.
     */
    activity?: ActivityResult,
  ): RunView {
    const shown =
      observed === null
        ? run
        : { ...run, status: observed.status, failureCode: observed.failureCode ?? run.failureCode };
    const projection = projectRun({ ...shown, candidateCount: counts.candidateCount });
    return {
      id: run.id,
      workspaceId: run.workspaceId,
      sourceProjectId: run.sourceProjectId,
      sourceKind: run.sourceKind,
      sourceDisplay: run.sourceDisplay,
      mode: run.mode,
      status: shown.status,
      currentStage: projection.currentStage,
      progress: activity?.progress ?? projection.progress,
      stages: projection.stages.map((stage) => ({ ...stage })),
      message: projection.message,
      failureCode: shown.failureCode,
      canCancel: projection.canCancel,
      canRetry: projection.canRetry && retryPossible !== false,
      ...counts,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      sourceTitle: run.sourceTitle ?? null,
      window: windowView(run),
      // Only beside the failure it explains: a run that was retried keeps the
      // column until its next failure overwrites it, and must not show it.
      failureDetail: shown.status === "failed" ? failureDetailOf(run.failureDetail) : null,
      nextWindowAvailable: nextWindowAvailable(run),
      automation: automationOf(run),
      waitingFor,
      steering: steeringOf(run.config),
      activity: activity?.activity ?? null,
    };
  }

  /**
   * Look for moments in the source's transcript (`ai.highlights`).
   *
   * Never fire-and-forget (2026-09-26): this used to be called from an
   * in-memory event with every error logged and dropped, which left a run on
   * "Finding promising moments" for good the first time an enqueue was
   * refused. Now every outcome is recorded — a refusal leaves the run waiting
   * with no job, which the reconciler notices and starts again; anything else
   * fails the run with `repurpose/highlights_failed`, which a retry restarts.
   *
   * The run reads `analyzing` BEFORE the job exists, and only if it is still in
   * an early status: a completion can land within a second of the enqueue, and
   * writing `analyzing` after it used to drag a finished discovery back to 45%.
   */
  async startHighlightDiscovery(run: RepurposeRun, transcriptId: string): Promise<DiscoveryStart> {
    if (run.mode === "manual") {
      // "I know the timestamps": no suggestions were asked for (the form sends
      // zero), so there is nothing to discover — the person picks the moments.
      const next = {
        status: "candidates_ready" as const,
        currentStage: "finding_clips",
        progress: 55,
      };
      const { count } = await this.prisma.repurposeRun.updateMany({
        where: { id: run.id, status: { in: [...PRE_CANDIDATE_STATUSES] } },
        data: next,
      });
      if (count === 0) return { outcome: "moved_on" };
      await this.publishStage({ ...run, ...next }, { candidateCount: 0 });
      return { outcome: "manual" };
    }

    const analyzing = { status: "analyzing" as const, currentStage: "finding_clips", progress: 45 };
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: { id: run.id, status: { in: [...PRE_CANDIDATE_STATUSES] } },
      data: analyzing,
    });
    if (count === 0) return { outcome: "moved_on" };
    if (run.status !== "analyzing") await this.publishStage({ ...run, ...analyzing });

    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      select: { id: true, currentRevision: true, language: true },
    });
    const revision = transcript?.currentRevision ?? 1;

    const media = await this.prisma.mediaAsset.findFirst({
      where: { projectId: run.sourceProjectId, role: "primary" },
      orderBy: { createdAt: "desc" },
    });

    const config = (run.config as Record<string, unknown>) ?? {};
    const discovery = (config["discovery"] as Record<string, unknown>) ?? {};
    const sourceLanguage = discoveryLanguage(transcript?.language, config["sourceLanguage"]);

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
        // Autopilot: every moment that clears the bar, scaled to the video's
        // length (`autopilotClipCount`), and a reserve of about a third more
        // that waits uncut for a removed clip's place (`autopilotAskCount`,
        // `autopilotPicks`); otherwise the number the form asked for.
        ...(automationOf(run) === "auto"
          ? {
              count: autopilotAskCount(autopilotClipCount(media?.durationMs)),
              minPotential: AUTOPILOT_MIN_POTENTIAL,
            }
          : {
              count: run.requestedCandidates || (discovery["requestedCandidates"] as number) || 5,
            }),
        // The clip length the person chose, else the run's bounds (15-60 s by default).
        ...discoveryBoundsOf(discovery),
        // Steering (2026-09-29): the topic, and the skipped start and end as
        // ranges on the processed file's own clock (`steeringOptionsOf`).
        ...steeringOptionsOf({
          config: run.config,
          offsetMs: media?.sourceOffsetMs ?? run.windowStartMs,
          fileDurationMs: media?.durationMs ?? null,
          sourceDurationMs: run.sourceDurationMs,
        }),
        contentGoal:
          (discovery["contentGoal"] as "reach" | "education" | "authority" | "engagement") ||
          "reach",
        language: sourceLanguage,
        // The language model's part (2026-09-29): the run's topic, the language
        // and script to write each clip's copy in, and who may read the words.
        ...(await discoveryModelOptionsFor(this.prisma, run, sourceLanguage)),
      },
      promptVersion: "highlights-v1",
      featureVersion: "features-v1",
    };

    try {
      const enqueued = await this.jobs.enqueue({
        type: "ai.highlights",
        workspaceId: run.workspaceId,
        projectId: run.sourceProjectId,
        params: payload,
        jobKey: highlightsJobKey(run.id, transcriptId, revision, "default"),
        worstCaseTenths: 0,
        reason: `ai.highlights · ${run.id}`,
        // Free, and the second half of a run the workspace was already admitted
        // for: the transcription that just finished can still be counted as in
        // flight here (its handler runs before its row flips), so on the Free
        // plan's two-job lane this was refused as often as not.
        skipAdmission: true,
      });
      return { outcome: "queued", jobId: enqueued.job.id };
    } catch (error) {
      // "Not now": the queue is down, or the database blinked (a local restart,
      // a full pool). Failing the run for either would make the person press
      // Retry for something that clears by itself.
      if (isRefusal(error) || isTransientDatabaseError(error)) {
        this.logger.warn(
          { runId: run.id, transcriptId, err: error },
          "discovery refused for now; the run waits and the reconciler starts it again",
        );
        return { outcome: "deferred" };
      }
      this.logger.error({ runId: run.id, transcriptId, err: error }, "could not start discovery");
      await this.failRun({ ...run, ...analyzing }, "repurpose/highlights_failed", "finding_clips");
      return { outcome: "failed" };
    }
  }

  /**
   * Fail a run that has no moments yet, with a code from the one failure
   * vocabulary (`failure-codes.ts`) and the stage it stopped on.
   *
   * Conditional on the run still being in an early status, which makes it safe
   * to call from any completion, at least once: a run the person stopped, one
   * already failed, or one that has moved on to its clips is left exactly as it
   * is. A clip's failure never comes through here.
   *
   * The numbers behind the failure go with it (`failure_detail`, 2026-09-27):
   * `detail` when the caller has them, `null` to say there are none. Left out,
   * they are worked out here where they can be - the balance for
   * `no_credits` - and for `source_too_long` the ones the probe put on the run
   * as it refused the file are kept, since the reconciler, which writes that
   * failure, never sees them. Anything else is cleared, so a run that failed
   * twice never shows the first failure's numbers under the second's code.
   *
   * @returns the failed run, or null when it had already moved on.
   */
  async failRun(
    run: RepurposeRun,
    code: RunFailureCode,
    stage: Stage,
    detail?: RunFailureDetail | null,
  ): Promise<RepurposeRun | null> {
    const failureDetail = await this.failureDetailFor(run, code, detail);
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: { id: run.id, status: { in: [...PRE_CANDIDATE_STATUSES] } },
      data: {
        status: "failed",
        failureCode: code,
        currentStage: stage,
        completedAt: new Date(),
        ...(failureDetail === undefined ? {} : { failureDetail }),
      },
    });
    if (count === 0) return null;

    const failed = await this.prisma.repurposeRun.findUnique({ where: { id: run.id } });
    if (failed === null) return null;
    this.logger.log(
      { runId: run.id, failureCode: code, stage, fromStatus: run.status },
      "run failed",
    );
    await this.audit.record({
      action: "repurpose.run.failed",
      resource: "repurpose_run",
      resourceId: run.id,
      actorKind: "system",
      workspaceId: run.workspaceId,
      data: { failureCode: code, stage, fromStatus: run.status },
    });
    await this.publishStage(failed);
    return failed;
  }

  /**
   * The `failure_detail` write for {@link failRun}: a value, `DbNull` to clear,
   * or undefined to leave the column as it is.
   */
  private async failureDetailFor(
    run: RepurposeRun,
    code: RunFailureCode,
    detail: RunFailureDetail | null | undefined,
  ): Promise<Prisma.InputJsonValue | typeof Prisma.DbNull | undefined> {
    if (detail !== undefined) return detail === null ? Prisma.DbNull : { ...detail };
    if (code === "repurpose/source_too_long") return undefined;
    if (code === "repurpose/no_credits") {
      try {
        const account = await this.prisma.creditAccount.findUnique({
          where: { workspaceId: run.workspaceId },
          select: { balanceTenths: true },
        });
        return { creditsLeft: creditsOf(account?.balanceTenths ?? 0) };
      } catch (error) {
        // The failure is the news; the number is a courtesy.
        this.logger.warn({ runId: run.id, err: error }, "could not read the balance for a failure");
      }
    }
    return Prisma.DbNull;
  }

  /**
   * Attach the numbers to a failure that another writer recorded first (the
   * reconciler can fail a run from its media row before the download's own
   * failure report arrives with them). Only while the run still shows that
   * failure: never onto a run that was retried meanwhile, or failed otherwise.
   */
  async recordFailureDetail(
    runId: string,
    code: RunFailureCode,
    detail: RunFailureDetail,
  ): Promise<void> {
    await this.prisma.repurposeRun.updateMany({
      where: { id: runId, status: "failed", failureCode: code },
      data: { failureDetail: { ...detail } },
    });
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
      // Not `materializing`: that is a run cutting its clips, and a clip that
      // failed — or one waiting for the plan's lane to free — is the clip's,
      // never the run's (clips hardening 2026-09-26, §4). Timing the run out
      // there hid every finished clip behind a failure card.
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
      const observed = (await this.observe(run))?.status ?? null;
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

      // 1. Move run to terminal failed state -- only if it is still where it was
      // read. Measuring a run takes a dozen queries, and a completion or the
      // reconciler that moved it meanwhile gave the real answer, which a
      // timeout must not overwrite.
      const { count: timedOut } = await this.prisma.repurposeRun.updateMany({
        where: { id: run.id, status: run.status },
        data: {
          status: "failed",
          failureCode: REPURPOSE_ERRORS.stageTimeout,
          currentStage,
          // A timeout has no numbers; an earlier failure's must not show under it.
          failureDetail: Prisma.DbNull,
        },
      });
      if (timedOut === 0) continue;

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
      return deadlines.getting_video ?? 30 * 60 * 1000;
    case "finding_clips":
      return deadlines.finding_clips ?? 30 * 60 * 1000;
    case "styles_formats":
      return deadlines.styles_formats ?? 30 * 60 * 1000;
    case "review":
      return deadlines.review ?? 30 * 60 * 1000;
    case "publish":
      return deadlines.publish ?? 30 * 60 * 1000;
    default:
      return 30 * 60 * 1000;
  }
}

export interface StuckRunsSweepReport {
  readonly examined: number;
  readonly failedRuns: string[];
  readonly releasedHolds: string[];
}
