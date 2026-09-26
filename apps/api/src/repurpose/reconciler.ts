import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { MediaAcquirePayloadSchema } from "@montaj/repurpose-contracts";

import {
  LEGACY_RUN_FAILURE_CODES,
  STAGE_OF_FAILURE,
  jobErrorCodeOf,
  runFailureCode,
} from "./failure-codes.js";
import { RepurposeClipsService } from "./repurpose-clips.service.js";
import {
  ACQUIRE_RUNNING_MARGIN_MS,
  ACQUIRE_TIMEOUT_MS,
  PRE_CANDIDATE_STATUSES,
  QUEUE_DOWN_BACKOFF_MS,
  RECONCILE_INTERVAL_MS,
  RECONCILE_WATCHDOG_MAX_RUNS,
  REPURPOSE_ERRORS,
  REPURPOSE_FLAGS,
  SETTLED_RUN_STATUSES,
  STAGE_RUNNING_BASE_MS,
  STAGE_RUNNING_PER_MEDIA_MS,
  UPLOAD_WINDOW_MS,
  reconcileWatchdogIntervalMs,
} from "./repurpose.constants.js";
import { progressForStatus, stageForStatus } from "./repurpose.projection.js";
import { RepurposeService, isRefusal, isUniqueViolation } from "./repurpose.service.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { MEDIA_JOB_KEYS } from "../media/media.constants.js";
import { AutoTranscribeTrigger } from "../transcripts/auto-transcribe.trigger.js";
import { quoteTranscription } from "../transcripts/transcripts.quote.js";

import type { FailedAt, RunFailureCode } from "./failure-codes.js";
import type { ReconcileReadOptions, RunReconciler } from "./repurpose.service.js";
import type { $Enums, Prisma, RepurposeRun } from "@prisma/client";

/**
 * The run is reconciled from durable state, not driven by events (clips
 * hardening 2026-09-26, `docs/repurpose/CLIPS-HARDENING-2026-09-26.md` §1).
 *
 * Every step after the download used to be started by an in-process event or a
 * fire-and-forget call, and every refusal along the way was logged and dropped.
 * The one watchdog is a scheduled sweep, and production runs with the scheduler
 * off — so a refused enqueue, a probe that failed, a transcription that never
 * started all left a run spinning on the same sentence forever (one has since
 * 2026-09-15).
 *
 * This looks at what actually exists — the source media and its jobs, the
 * transcript, the discovery job, the clips — and moves the run to where that
 * says it is: it starts the step that is missing, or fails the run with the
 * code for the step that failed. It runs on every read of a run (throttled per
 * run), at the end of every completion that concerns one, and from an
 * in-process watchdog every `REPURPOSE_RECONCILE_INTERVAL_MS` — so nothing needs
 * a scheduler, and nothing needs a page open either. It is idempotent: every
 * enqueue it makes dedupes on its job key, and every write is conditional on
 * the run still being where it was read.
 */

/** Enough of one job to tell live, finished, failed and lost apart. */
export interface JobFacts {
  readonly status: $Enums.JobStatus;
  readonly errorCode: string | null;
  /** A worker picked it up (`started_at` is set). */
  readonly started: boolean;
  /** The job row, so one that has stalled can be cancelled. */
  readonly id?: string;
  /**
   * When it was queued and when a worker started it (ms since the epoch). The
   * timings are optional so a caller holding only the status still gets an
   * answer; without them a job is never read as stalled.
   */
  readonly queuedAt?: number;
  readonly startedAt?: number | null;
  /** The plan's queue wait it was admitted with (`jobs.max_queue_wait_ms`). */
  readonly maxQueueWaitMs?: number | null;
  /** A download's own deadline, from its payload (`limits.timeoutMs`). */
  readonly timeoutMs?: number | null;
}

/** Everything the decision reads, as plain data, so the decision is a pure function. */
export interface RunSnapshot {
  /**
   * When this was read (ms since the epoch). A job's age and an upload's wait
   * are measured against it, so the decision stays a pure function of the
   * snapshot rather than of the clock.
   */
  readonly now: number;
  /**
   * When the source was last asked for: the newest media row's creation (an
   * upload's ticket), or the run's own while it has none. An upload still not
   * arrived {@link UPLOAD_WINDOW_MS} after this is given up on.
   */
  readonly sourceRequestedAt: number;
  readonly sourceKind: $Enums.RepurposeSourceKind;
  /**
   * The source project is gone (deleted from the projects page, erased): there
   * is nothing left to fetch into, transcribe or look through.
   */
  readonly sourceDeleted: boolean;
  /** The source project's newest primary media. */
  readonly media: {
    readonly status: $Enums.MediaStatus;
    readonly failureReason: string | null;
    /** The bytes arrived (`uploaded_at`): a fetched link is past its download. */
    readonly arrived: boolean;
    readonly durationMs: number | null;
  } | null;
  /** The newest `media.acquire` that fetches into THAT media row. */
  readonly acquireJob: JobFacts | null;
  /**
   * The newest `media.probe` or `media.proxy` of that media row, while it is
   * being prepared (`uploaded`, `probing`); null otherwise.
   */
  readonly processingJob: JobFacts | null;
  /** An earlier fetch left the address behind, so the link can be fetched again. */
  readonly canRefetch: boolean;
  readonly transcriptId: string | null;
  /**
   * The newest `ai.transcribe` for that media row — unless it ended before the
   * run was last written, which means the run has already answered for it
   * (it failed the run, and a retry has reopened it since).
   */
  readonly transcribeJob: JobFacts | null;
  /** The newest `ai.highlights` for this run and that transcript, on the same terms. */
  readonly highlightsJob: JobFacts | null;
  /** Moments the run already has, suggested or added by hand. */
  readonly candidateCount: number;
}

export type RunAction =
  | { readonly kind: "wait" }
  | { readonly kind: "fail"; readonly failedAt: FailedAt; readonly code: RunFailureCode }
  | { readonly kind: "acquire" }
  | { readonly kind: "transcribe" }
  | { readonly kind: "discover" }
  | { readonly kind: "candidates_ready" };

const WAIT: RunAction = { kind: "wait" };

/**
 * A job row that never reached the queue. `JobsService.enqueue` leaves the row
 * `failed` with `common/unavailable` when the queue itself refused the add; no
 * worker ever saw it, so it is not a failure of the step — it is a step that
 * has not been started yet.
 */
function presentJob(job: JobFacts | null): JobFacts | null {
  if (job === null) return null;
  if (refusedByQueue(job)) return null;
  return job;
}

function isOver(job: JobFacts): boolean {
  return job.status === "failed" || job.status === "cancelled";
}

/**
 * How long a download may run: its own deadline, which the worker enforces,
 * plus a margin. Past it the worker is gone, not slow.
 */
export function acquireCeilingMs(job: JobFacts): number {
  const timeoutMs = job.timeoutMs ?? null;
  return (
    (timeoutMs !== null && timeoutMs > 0 ? timeoutMs : ACQUIRE_TIMEOUT_MS) +
    ACQUIRE_RUNNING_MARGIN_MS
  );
}

/** How long the probe, the proxy, the transcription or discovery may run: scaled to the video. */
export function workCeilingMs(durationMs: number | null): number {
  return STAGE_RUNNING_BASE_MS + STAGE_RUNNING_PER_MEDIA_MS * Math.max(0, durationMs ?? 0);
}

/**
 * A job still open long past the point it could finish: queued past its plan's
 * `maxQueueWaitMs`, or running past `ceilingMs` (see `STAGE_RUNNING_BASE_MS`).
 * The run-level twin of the clips' `stalledCode` (`clip-state.ts`). Such a job
 * is over as far as the run is concerned — nothing is coming back from it in
 * time — so the run fails for it. Which of them are then cancelled is
 * {@link stalledJobIds}'s question.
 */
export function isStalled(job: JobFacts, ceilingMs: number, now: number): boolean {
  if (job.status === "queued") {
    const waitMs = job.maxQueueWaitMs ?? null;
    return job.queuedAt !== undefined && waitMs !== null && now - job.queuedAt > waitMs;
  }
  if (job.status === "running") {
    const since = job.startedAt ?? job.queuedAt;
    return since !== undefined && since !== null && now - since > ceilingMs;
  }
  return false;
}

/** The work ceiling for this snapshot's video. */
function workCeilingOf(snapshot: RunSnapshot): number {
  return workCeilingMs(snapshot.media?.durationMs ?? null);
}

/**
 * The run's jobs, among those it read, that have stalled ({@link isStalled}),
 * by id: what a retry cancels before it starts the stage again (`preparation:
 * true`, the default), and what the reconciler cancels once it has failed the
 * run for them (`preparation: false`).
 *
 * The media's probe and proxy (`processingJob`) are cancelled only on a retry.
 * They are the source project's media pipeline, not the run's: they take no
 * lane slot and hold no credit (`skipAdmission`), so cancelling one gives
 * nothing back, and it cannot be undone — the BullMQ job is removed, a
 * cancelled proxy marks the media failed, and a cancelled probe leaves it
 * `uploaded` for good, since nothing re-probes an uploaded file. When
 * worker-media is merely down for a while (CLAUDE.md §8), a queued probe left
 * alone runs once it is back, the media reaches `ready`, and "Try again"
 * transcribes it; cancelled, that upload could never be used again. A retry
 * cancels it only where it then fetches the link into a fresh media row
 * ({@link planRetry} is `impossible` for an upload whose preparation stalled,
 * so a retry never reaches the cancel for one).
 */
export function stalledJobIds(
  snapshot: RunSnapshot,
  options: { readonly preparation?: boolean } = {},
): string[] {
  const work = workCeilingOf(snapshot);
  const read: Array<{ readonly job: JobFacts | null; readonly ceilingMs: number }> = [
    {
      job: snapshot.acquireJob,
      ceilingMs: snapshot.acquireJob === null ? 0 : acquireCeilingMs(snapshot.acquireJob),
    },
    ...(options.preparation === false ? [] : [{ job: snapshot.processingJob, ceilingMs: work }]),
    { job: snapshot.transcribeJob, ceilingMs: work },
    { job: snapshot.highlightsJob, ceilingMs: work },
  ];
  return read.flatMap(({ job, ceilingMs }) =>
    job?.id !== undefined && isStalled(job, ceilingMs, snapshot.now) ? [job.id] : [],
  );
}

function fail(failedAt: FailedAt, mediaReason: string | null, jobErrorCode: string | null) {
  return {
    kind: "fail",
    failedAt,
    code: runFailureCode({ failedAt, mediaReason, jobErrorCode }),
  } as const;
}

/**
 * A step that stopped making progress: its job is still open, long past the
 * point it could finish. Not the stage's own failure code — nothing says the
 * video or the file was at fault — but the one whose copy says a stage stalled
 * and that trying again restarts it.
 */
function timedOut(failedAt: FailedAt): RunAction {
  return { kind: "fail", failedAt, code: "repurpose/stage_timeout" };
}

/**
 * The media arrived, and the step preparing it — the probe or the proxy —
 * ended without it. The proxy's failure handler marks the media failed; the
 * probe has none, so a probe that failed (or a media PATCH that never landed)
 * leaves the media `uploaded` or `probing` for good. A step still open long
 * past the point it could finish has ended too (`stalled`): its worker died, or
 * BullMQ failed it for stalling with no callback at all.
 */
function preparationEnded(
  snapshot: RunSnapshot,
): { readonly errorCode: string | null; readonly stalled: boolean } | null {
  const status = snapshot.media?.status;
  if (status !== "uploaded" && status !== "probing") return null;
  const job = presentJob(snapshot.processingJob);
  if (job === null) return null;
  if (isOver(job)) return { errorCode: job.errorCode, stalled: false };
  return isStalled(job, workCeilingOf(snapshot), snapshot.now)
    ? { errorCode: null, stalled: true }
    : null;
}

/**
 * An upload run whose file has not arrived — no media row, or one still
 * `pending` or `uploading` — for longer than {@link UPLOAD_WINDOW_MS}.
 */
function uploadAbandoned(snapshot: RunSnapshot): boolean {
  if (snapshot.sourceKind !== "upload" || !uploadNotArrived(snapshot)) return false;
  return snapshot.now - snapshot.sourceRequestedAt > UPLOAD_WINDOW_MS;
}

function uploadNotArrived(snapshot: RunSnapshot): boolean {
  const status = snapshot.media?.status;
  return status === undefined || status === "pending" || status === "uploading";
}

/** The source project is gone: the run fails as a video we no longer have. */
const SOURCE_GONE: RunAction = {
  kind: "fail",
  failedAt: "acquire",
  code: "repurpose/source_unavailable",
};

/**
 * An upload that never arrived. Nothing on the run page can add a file to it
 * (the browser's upload queue is the only thing that could, and it has given
 * up), so the run says so and offers another video rather than read "Add a
 * video to get started" for good — and show on Home as working at 0%.
 */
const UPLOAD_MISSING: RunAction = {
  kind: "fail",
  failedAt: "acquire",
  code: "repurpose/upload_missing",
};

/**
 * What a run that has no moments yet should do next (§1's table). Read top to
 * bottom it is the pipeline backwards: the furthest step that exists decides,
 * so a transcript makes the state of the download irrelevant.
 */
export function decideRunAction(snapshot: RunSnapshot): RunAction {
  if (snapshot.sourceDeleted) return SOURCE_GONE;

  if (snapshot.transcriptId !== null) {
    const job = presentJob(snapshot.highlightsJob);
    if (job === null) return { kind: "discover" };
    if (isOver(job)) return fail("highlights", null, job.errorCode);
    if (job.status === "succeeded") {
      // Succeeded while the run still reads "finding". The completion stores
      // the moments and moves the run in one transaction, so a result that was
      // applied never looks like this: it was turned away (the run had failed
      // or stopped at the time, and was retried since) and its moments were
      // never stored. Look again — unless the run has moments anyway (a row
      // written before the move and the insert were one step).
      return snapshot.candidateCount > 0 ? { kind: "candidates_ready" } : { kind: "discover" };
    }
    // Queued or running — unless for longer than it ever could.
    return isStalled(job, workCeilingOf(snapshot), snapshot.now) ? timedOut("highlights") : WAIT;
  }

  if (uploadAbandoned(snapshot)) return UPLOAD_MISSING;
  const media = snapshot.media;
  // An upload whose browser has not asked for a ticket yet.
  if (media === null) return WAIT;

  if (snapshot.sourceKind !== "upload" && !media.arrived) {
    // The worker marks the media failed, with its reason, before it reports
    // the job — so this can be seen a moment before the job says so.
    if (media.status === "failed") {
      return fail("acquire", media.failureReason, snapshot.acquireJob?.errorCode ?? null);
    }
    const job = presentJob(snapshot.acquireJob);
    if (job === null) {
      // Nothing is fetching into it: its enqueue was refused (a full lane on a
      // retry), so fetch it now. With no address yet, `create` is between
      // reserving the row and queueing the job that carries the address.
      return media.status === "pending" && snapshot.canRefetch ? { kind: "acquire" } : WAIT;
    }
    if (isOver(job)) return fail("acquire", media.failureReason, job.errorCode);
    // Queued or running, or succeeded with the hand-off to probing in flight —
    // unless it is still open long after its own deadline: the acquisition
    // worker died, or never started (CLAUDE.md §8), and nothing reports it.
    return isStalled(job, acquireCeilingMs(job), snapshot.now) ? timedOut("acquire") : WAIT;
  }

  switch (media.status) {
    case "failed":
      // Past the download: the probe or proxy could not read it, or the probe
      // measured it over the plan's duration cap.
      return fail("processing", media.failureReason, null);
    case "ready":
      break;
    default: {
      // Still uploading, or being probed and prepared — unless preparing it
      // ended with nothing written back, which would otherwise read
      // "Getting your video" for good.
      const ended = preparationEnded(snapshot);
      if (ended === null) return WAIT;
      return ended.stalled
        ? timedOut("processing")
        : fail("processing", media.failureReason, ended.errorCode);
    }
  }
  if (media.durationMs === null || media.durationMs <= 0) return WAIT;

  const job = presentJob(snapshot.transcribeJob);
  if (job === null) return { kind: "transcribe" };
  if (isOver(job)) return fail("transcription", null, job.errorCode);
  // Queued or running, or succeeded with the transcript still being written —
  // unless a worker lost it (a callback that never landed leaves it `running`).
  return isStalled(job, workCeilingOf(snapshot), snapshot.now) ? timedOut("transcription") : WAIT;
}

/** What a retry does, decided from the same snapshot (§3). */
export type RetryPlan =
  | { readonly kind: "restore" }
  | { readonly kind: "discover" }
  | { readonly kind: "transcribe" }
  | { readonly kind: "acquire"; readonly reuseMedia: boolean }
  | { readonly kind: "resume" }
  | { readonly kind: "impossible"; readonly reason: string };

/** Failures a retry answers by looking for moments again, even when some exist. */
const DISCOVERY_FAILURES: ReadonlySet<string> = new Set([
  "repurpose/highlights_failed",
  "repurpose/highlights_no_candidates",
  LEGACY_RUN_FAILURE_CODES.analysisFailed,
]);

/**
 * "Run the failed stage again". The stage is read from durable state rather
 * than from the failure code alone, because the code can be one that says
 * nothing about where (`stage_timeout`, an old row's `clip_failed`) — and
 * because re-running a stage whose output already exists would only redo work.
 */
export function planRetry(
  snapshot: RunSnapshot,
  context: { readonly failureCode: string | null },
): RetryPlan {
  if (snapshot.sourceDeleted) {
    return {
      kind: "impossible",
      reason: "This video's project was deleted. Start a new video with it.",
    };
  }
  if (context.failureCode === REPURPOSE_ERRORS.transcriptUntimed) {
    // Looking again reads the same words with the same missing timings, and
    // this run's source already has a transcript, which is what stops a first
    // transcription from starting. Starting the video again makes a new
    // project, and transcribes it afresh.
    return {
      kind: "impossible",
      reason:
        "This video's transcript has no word timings, so no moment can be placed in it. Start the video again to transcribe it afresh.",
    };
  }
  if (snapshot.candidateCount > 0 && !DISCOVERY_FAILURES.has(context.failureCode ?? "")) {
    // It already had moments (an old run a clip failed, a timeout while
    // cutting): nothing upstream needs doing again, it goes back to them.
    return { kind: "restore" };
  }
  if (snapshot.transcriptId !== null) return { kind: "discover" };

  const media = snapshot.media;
  if (media?.status === "ready" && media.durationMs !== null && media.durationMs > 0) {
    return { kind: "transcribe" };
  }

  if (snapshot.sourceKind !== "upload") {
    const fetching = presentJob(snapshot.acquireJob);
    if (
      media !== null &&
      !media.arrived &&
      // A failed media row is over whatever its job row says: a download
      // whose final report was lost (an API restart) still reads `running`,
      // and "resuming" it would fail the run again on the next read, for
      // good. It gets a fresh row and a fresh job instead.
      media.status !== "failed" &&
      fetching !== null &&
      !isOver(fetching) &&
      // A download open long past its own deadline is lost, not slow:
      // "resuming" it would watch it for good. `redrive` cancels it first, and
      // the fetch starts again.
      !isStalled(fetching, acquireCeilingMs(fetching), snapshot.now)
    ) {
      // Still downloading (the run was timed out, not the download): a second
      // fetch would write into the same file or leave two copies to transcribe.
      // The run goes back to watching the one in flight.
      return { kind: "resume" };
    }
    if (!snapshot.canRefetch) {
      return {
        kind: "impossible",
        reason: "This link cannot be fetched again. Start a new video with it.",
      };
    }
    // A download that never started (its enqueue was refused) goes into the row
    // already waiting for it; anything that got further gets a clean one.
    return { kind: "acquire", reuseMedia: media?.status === "pending" && !media.arrived };
  }

  // Preparing it ended with the media left `uploaded` or `probing`: the same
  // unreadable file, and "resuming" would only fail the run again.
  const preparation = preparationEnded(snapshot);
  if (media?.status === "failed" || (preparation !== null && !preparation.stalled)) {
    return {
      kind: "impossible",
      reason: "This file could not be read. Upload it again, or choose another video.",
    };
  }
  // A preparation that stalled is still open (the run never cancels it, see
  // `stalledJobIds`), and nothing in a run can send an uploaded file back
  // through the probe. If it runs late the media reaches `ready`, and this
  // same plan then says `transcribe`.
  if (preparation !== null) {
    return {
      kind: "impossible",
      reason:
        "This file is still waiting to be prepared. Try again once it has been, or upload it again.",
    };
  }
  // The file never arrived, and nothing on the run's page can send it: only a
  // new upload helps. "Resuming" would fail the run again on the next read.
  if (
    uploadNotArrived(snapshot) &&
    (context.failureCode === REPURPOSE_ERRORS.uploadMissing || uploadAbandoned(snapshot))
  ) {
    return {
      kind: "impossible",
      reason: "This file never finished uploading. Upload it again, or choose another video.",
    };
  }
  // An upload still arriving, or being prepared: nothing to restart, only a
  // failure to clear.
  return { kind: "resume" };
}

interface JobRow {
  readonly id: string;
  readonly status: $Enums.JobStatus;
  readonly error: Prisma.JsonValue | null;
  readonly queuedAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly maxQueueWaitMs: number | null;
  readonly params: Prisma.JsonValue;
}

function factsOf(job: JobRow | undefined | null): JobFacts | null {
  if (job === undefined || job === null) return null;
  return {
    id: job.id,
    status: job.status,
    errorCode: jobErrorCodeOf(job.error),
    started: job.startedAt !== null,
    queuedAt: job.queuedAt.getTime(),
    startedAt: job.startedAt?.getTime() ?? null,
    maxQueueWaitMs: job.maxQueueWaitMs,
    timeoutMs: timeoutOf(job),
  };
}

/** A download's `limits.timeoutMs`, from its payload; null for any other job. */
function timeoutOf(job: JobRow): number | null {
  const limits = paramOf(job, "limits");
  if (typeof limits !== "object" || limits === null) return null;
  const timeoutMs = (limits as Record<string, unknown>)["timeoutMs"];
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) ? timeoutMs : null;
}

/**
 * {@link factsOf}, except a step that ended before the run was last written
 * counts as absent: the run has already answered for it.
 *
 * Nothing writes a run that has not reached its moments apart from a status
 * move — failing it, stopping it, a retry reopening it, discovery starting —
 * so an ended job older than the last write is one that failed the run, which a
 * retry has since reopened. Without this, a retried transcription the plan's
 * lane refused left the old failed job as the newest one, and the next read
 * failed the run again for the old reason; a retry had to answer 503 instead
 * of leaving the run open for the lane to free.
 */
function unansweredFactsOf(job: JobRow | undefined, runWrittenAt: Date): JobFacts | null {
  const facts = factsOf(job);
  if (facts === null || job === undefined || !isOver(facts) || job.finishedAt === null)
    return facts;
  return job.finishedAt.getTime() < runWrittenAt.getTime() ? null : facts;
}

/** The queue itself refused this enqueue (see {@link presentJob}). */
function refusedByQueue(job: JobFacts | null): boolean {
  return (
    job !== null &&
    job.status === "failed" &&
    !job.started &&
    job.errorCode === ERROR_CODES.unavailable
  );
}

function paramOf(job: JobRow, key: string): unknown {
  const params = job.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return undefined;
  // eslint-disable-next-line security/detect-object-injection -- `key` is one of this file's literals
  return (params as Record<string, unknown>)[key];
}

const JOB_FIELDS = {
  id: true,
  status: true,
  error: true,
  queuedAt: true,
  startedAt: true,
  finishedAt: true,
  maxQueueWaitMs: true,
  params: true,
} as const;

/** How many of a run's newest jobs of one type are looked through. A run makes a handful. */
const JOB_LOOKBACK = 20;

/** The media columns the reconciler and its producers read. */
interface SourceMedia {
  readonly id: string;
  readonly bucket: $Enums.StorageBucket;
  readonly storageKey: string;
  readonly status: $Enums.MediaStatus;
  readonly failureReason: string | null;
  readonly uploadedAt: Date | null;
  readonly durationMs: number | null;
  readonly createdAt: Date;
}

/** The source project columns a transcription start depends on. */
interface SourceProject {
  readonly createdBy: string | null;
  readonly sourceLanguage: string | null;
}

interface ReadState {
  readonly snapshot: RunSnapshot;
  readonly media: SourceMedia | null;
  /** Null when the source project is gone (then `snapshot.sourceDeleted`). */
  readonly project: SourceProject | null;
  readonly refetchUrl: string | null;
}

/** How a transcription start ended. */
type TranscriptionStart =
  | "queued"
  | "no_credits"
  /** Something waiting will not fix: nobody to charge, no language to transcribe in. */
  | "cannot_start"
  /** A full plan lane: the next reconcile tries again. */
  | "deferred"
  /** The queue itself is down: tried again after a back-off. */
  | "queue_down";

/** Statuses past discovery that a LIST read still reconciles: their clips may be waiting for a slot. */
const LIST_CLIP_STATUSES: ReadonlySet<string> = new Set(["candidates_ready", "materializing"]);

/** An in-memory stamp map must not grow with every run ever read. */
const STAMP_PRUNE_AT = 5_000;

@Injectable()
export class RepurposeReconciler
  implements RunReconciler, OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RepurposeReconciler.name);
  private readonly reconciledAt = new Map<string, number>();
  private watchdog: NodeJS.Timeout | undefined;
  /** The watchdog pass in flight, so passes never overlap and shutdown can wait for one. */
  private sweeping: Promise<void> | undefined;
  /**
   * Set at shutdown: a pass in flight stops at the next run instead of working
   * through up to {@link RECONCILE_WATCHDOG_MAX_RUNS} of them, one after
   * another, while Nest tears down the Prisma client they read through (it
   * promises no order between providers).
   */
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly runs: RepurposeService,
    private readonly autoTranscribe: AutoTranscribeTrigger,
    private readonly clips: RepurposeClipsService,
  ) {}

  /**
   * The run service reads through this, and this drives the run through the
   * service's producers — a cycle as constructor injection, so this side
   * registers itself instead, the way completion handlers do with their registry.
   */
  onModuleInit(): void {
    this.runs.useReconciler(this);
  }

  /**
   * Start the watchdog (see `DEFAULT_RECONCILE_WATCHDOG_MS`): every interval,
   * every run that has not settled is reconciled, so work refused "for now"
   * starts once the lane frees whether or not anyone has a page open. Not tied
   * to the scheduler, which production runs with off. `unref()`'d, so it never
   * keeps a process alive on its own.
   */
  onApplicationBootstrap(): void {
    const every = reconcileWatchdogIntervalMs();
    if (every <= 0) {
      this.logger.log("run reconcile watchdog disabled (REPURPOSE_RECONCILE_INTERVAL_MS=0)");
      return;
    }
    this.watchdog = setInterval(() => {
      void this.sweepOnce();
    }, every);
    this.watchdog.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
    // The run a pass is on is left to finish rather than cut off mid-write
    // (`stopping` ends the pass after it); a pass never throws.
    await this.sweeping;
  }

  /**
   * One watchdog pass, unless the last is still going or the process is
   * shutting down. Never throws: a timer's rejection has nowhere to go, and the
   * next pass tries again.
   */
  sweepOnce(now?: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.sweeping !== undefined) return this.sweeping;
    const pass = this.sweep(now).finally(() => {
      this.sweeping = undefined;
    });
    this.sweeping = pass;
    return pass;
  }

  /**
   * Reconcile, one at a time, every run that has not settled — newest first,
   * at most {@link RECONCILE_WATCHDOG_MAX_RUNS} — through the same throttle a
   * read uses, so a run its own page is polling is not reconciled twice.
   *
   * A workspace whose `repurpose_flow` is off is skipped: the kill switch
   * (`FEATURE_FLAGS_JSON`) stops the whole surface, and that has to include
   * work started in the background, which spends credits on transcriptions.
   */
  private async sweep(now?: number): Promise<void> {
    try {
      const runs = await this.prisma.repurposeRun.findMany({
        where: { status: { notIn: [...SETTLED_RUN_STATUSES] } },
        orderBy: { id: "desc" },
        take: RECONCILE_WATCHDOG_MAX_RUNS,
      });
      const enabled = new Map<string, boolean>();
      for (const run of runs) {
        if (this.stopping) return;
        let on = enabled.get(run.workspaceId);
        if (on === undefined) {
          on = await this.flowEnabled(run.workspaceId);
          enabled.set(run.workspaceId, on);
        }
        if (!on) continue;
        await this.reconcileIfDue(run, {}, now ?? Date.now());
      }
    } catch (error) {
      this.logger.warn({ err: error }, "run reconcile watchdog pass failed; the next one retries");
    }
  }

  /** One workspace's entitlements failing to load skips it this pass, not everyone after it. */
  private async flowEnabled(workspaceId: string): Promise<boolean> {
    try {
      return await this.runs.flagEnabled(workspaceId, REPURPOSE_FLAGS.flow);
    } catch (error) {
      this.logger.warn(
        { workspaceId, err: error },
        "could not read the workspace's flags; skipped",
      );
      return false;
    }
  }

  /**
   * Whether "Try again" on `run` would restart anything: the plan
   * {@link redrive} follows, from the same snapshot. The page offers the button
   * only when it would (2026-09-26: it offered it as the main action on runs
   * the endpoint always refused with 409 — an upload that could not be read, a
   * project that was deleted).
   *
   * @param failureCode the failure the page is showing, which a read can derive
   *   before the reconciler has written it to the row.
   */
  async retryPossible(run: RepurposeRun, failureCode: string | null): Promise<boolean> {
    const state = await this.read(run);
    return planRetry(state.snapshot, { failureCode }).kind !== "impossible";
  }

  /**
   * {@link reconcile}, at most once per {@link RECONCILE_INTERVAL_MS} per run
   * (longer after the queue refused one of its enqueues): for reads.
   *
   * A list read leaves a run that is already cutting or reviewing its clips
   * alone unless one may be waiting for a slot: that run's own page and its
   * clip completions reconcile it, and a home page listing fifty of them on
   * every poll should not.
   */
  async reconcileIfDue(
    run: RepurposeRun,
    options: ReconcileReadOptions = {},
    now: number = Date.now(),
  ): Promise<RepurposeRun> {
    if (isSettled(run.status)) return run;
    if (
      options.forList === true &&
      !isPreCandidate(run.status) &&
      !LIST_CLIP_STATUSES.has(run.status)
    ) {
      return run;
    }
    const last = this.reconciledAt.get(run.id);
    if (last !== undefined && now - last < RECONCILE_INTERVAL_MS) return run;
    return this.reconcile(run, now);
  }

  /**
   * Move `run` to where durable state says it is, and return it as it now
   * stands. Never throws: a read must still be served and a completion must
   * still land if reconciling fails, and the next read tries again.
   */
  async reconcile(run: RepurposeRun, now: number = Date.now()): Promise<RepurposeRun> {
    this.stamp(run.id, now);
    try {
      return await this.step(run, now);
    } catch (error) {
      this.logger.warn(
        { runId: run.id, err: error },
        "could not reconcile the run; served as it stands",
      );
      return run;
    }
  }

  /**
   * Run the stage that failed again (`POST /repurpose/runs/{id}/retry`). The
   * caller has checked the run is `failed`. Clears the failure, starts the
   * stage, and leaves anything that is refused "for now" to the next reconcile
   * — a full plan lane is not an error, so the answer is the run, open.
   *
   * A job of the run still open long past the point it could finish is
   * cancelled first ({@link stalledJobIds}): it holds a lane slot, and for a
   * transcription a credit hold, and a fresh enqueue would only dedupe onto it.
   * Its failure handler can change the state the plan was read from (a
   * download's marks its media failed), so the plan is read again after.
   *
   * @throws 409 when there is no stage a retry can restart (an upload that could
   *   not be read, a deleted project), or when the link has been started again
   *   in another run meanwhile (`repurpose/source_already_running`).
   */
  async redrive(run: RepurposeRun): Promise<RepurposeRun> {
    let state = await this.read(run);
    let plan = planRetry(state.snapshot, { failureCode: run.failureCode });
    const stale = plan.kind === "impossible" ? [] : stalledJobIds(state.snapshot);
    if (stale.length > 0) {
      await this.runs.cancelJobs(run, stale);
      state = await this.read(run);
      plan = planRetry(state.snapshot, { failureCode: run.failureCode });
    }

    switch (plan.kind) {
      case "impossible":
        throw new AppException(REPURPOSE_ERRORS.notRetryable, plan.reason, HttpStatus.CONFLICT);

      case "restore": {
        const ready = await this.prisma.repurposeClip.count({
          where: { runId: run.id, mezzanineKey: { not: null } },
        });
        const reopened = await this.reopen(run, ready > 0 ? "review_ready" : "candidates_ready");
        if (reopened === null) return this.current(run);
        // Clips that were waiting for a slot, or whose cut the old code
        // abandoned with the run, are the clip service's to pick up.
        await this.clips.reconcileClips(run.id);
        return this.current(run);
      }

      case "discover": {
        // `analyzing` BEFORE the enqueue: the completion handler turns away any
        // result for a run that is not in an early status, and a fast one can
        // land before this call returns.
        const reopened = await this.reopen(run, "analyzing");
        if (reopened === null || state.snapshot.transcriptId === null) return this.current(run);
        const started = await this.runs.startHighlightDiscovery(
          reopened,
          state.snapshot.transcriptId,
        );
        // Refused for now: the run reads "finding", the old failure is answered
        // for, and the reconciler starts discovery after the back-off.
        if (started.outcome === "deferred") this.backOff(run.id);
        return this.current(run);
      }

      case "transcribe": {
        const reopened = await this.reopen(run, "draft");
        if (reopened === null || state.media === null) return this.current(run);
        const started = await this.startTranscription(reopened, state.media, state.project);
        if (started === "no_credits" || started === "cannot_start") {
          await this.runs.failRun(
            reopened,
            started === "no_credits" ? "repurpose/no_credits" : "repurpose/transcription_failed",
            STAGE_OF_FAILURE.transcription,
          );
        } else if (started === "queue_down") {
          this.backOff(run.id);
        }
        // "deferred" (a full lane) leaves the run open: the transcription that
        // failed ended before the reopen, so the reconciler no longer counts it
        // (`unansweredFactsOf`), and starts this one on a later read once the
        // lane frees.
        return this.current(run);
      }

      case "acquire": {
        if (state.refetchUrl === null) return this.current(run);
        const reopened = await this.reopen(run, "draft");
        if (reopened === null) return this.current(run);
        try {
          await this.runs.reacquire(
            reopened,
            state.refetchUrl,
            plan.reuseMedia && state.media !== null ? state.media : undefined,
          );
        } catch (error) {
          // A full lane leaves a pending media row with no job, which the next
          // reconcile fetches into once the lane frees. Anything else is a real
          // refusal, and the run goes back to the failure it had.
          if (!isRefusal(error)) {
            await this.restoreFailure(reopened, run);
            throw error;
          }
          if (isQueueDown(error)) this.backOff(run.id);
          this.logger.log(
            { runId: run.id },
            "retried download refused for now; reconcile will fetch",
          );
        }
        return this.current(run);
      }

      case "resume": {
        await this.reopen(run, "draft");
        return this.current(run);
      }
    }
  }

  private async step(run: RepurposeRun, now: number): Promise<RepurposeRun> {
    if (isSettled(run.status)) return run;

    if (!isPreCandidate(run.status)) {
      // Past discovery the run is its clips: ones refused a slot are enqueued
      // now, and a run whose clips have all settled moves on.
      await this.clips.reconcileClips(run.id);
      return this.current(run);
    }

    const state = await this.read(run, now);
    const action = decideRunAction(state.snapshot);
    switch (action.kind) {
      case "wait":
        return run;

      case "fail": {
        const failed = await this.runs.failRun(run, action.code, STAGE_OF_FAILURE[action.failedAt]);
        if (failed === null) return this.current(run);
        // A stalled job would otherwise keep its lane slot (two of them block a
        // Free workspace outright) and a transcription's credit hold until
        // someone pressed Try again. Cancelled only now the run reads failed:
        // its failure handler then finds a run that has already answered, and
        // leaves the failure this pass wrote in place. Not the media's probe
        // or proxy: those free nothing, and a late one is still the only way
        // an upload gets prepared (see `stalledJobIds`).
        const stale = stalledJobIds(state.snapshot, { preparation: false });
        if (stale.length > 0) await this.runs.cancelJobs(failed, stale);
        return failed;
      }

      case "acquire":
        if (state.refetchUrl === null || state.media === null) return run;
        try {
          await this.runs.reacquire(run, state.refetchUrl, state.media);
        } catch (error) {
          if (error instanceof AppException && !isRefusal(error)) {
            // Refused for good — links switched off for the workspace, the
            // project deleted under it: waiting will not fetch it, so the run
            // says it could not get the video rather than spin on it.
            this.logger.warn({ runId: run.id, err: error }, "the download cannot be restarted");
            const failed = await this.runs.failRun(
              run,
              "repurpose/source_unavailable",
              STAGE_OF_FAILURE.acquire,
            );
            return failed ?? this.current(run);
          }
          // Refused for now (a full lane, a queue that is down), or the
          // database blinked: the run keeps waiting, honestly, and a later read
          // tries again.
          if (isQueueDown(error)) this.backOff(run.id, now);
          this.logger.warn({ runId: run.id, err: error }, "could not restart the download");
        }
        return this.current(run);

      case "transcribe": {
        if (state.media === null) return run;
        const started = await this.startTranscription(run, state.media, state.project);
        if (started === "no_credits" || started === "cannot_start") {
          const failed = await this.runs.failRun(
            run,
            started === "no_credits" ? "repurpose/no_credits" : "repurpose/transcription_failed",
            STAGE_OF_FAILURE.transcription,
          );
          return failed ?? this.current(run);
        }
        if (started === "queue_down") this.backOff(run.id, now);
        return run;
      }

      case "discover": {
        if (state.snapshot.transcriptId === null) return run;
        const started = await this.runs.startHighlightDiscovery(run, state.snapshot.transcriptId);
        if (started.outcome === "deferred") this.backOff(run.id, now);
        return this.current(run);
      }

      case "candidates_ready": {
        const next = {
          status: "candidates_ready" as const,
          currentStage: "finding_clips",
          progress: 55,
        };
        const { count } = await this.prisma.repurposeRun.updateMany({
          where: { id: run.id, status: { in: [...PRE_CANDIDATE_STATUSES] } },
          data: next,
        });
        const moved = await this.current(run);
        if (count > 0) await this.runs.publishStage(moved);
        return moved;
      }
    }
  }

  /**
   * Start the first transcription of the source media, through the same seam
   * every upload uses, so it dedupes with any other start and holds its credits
   * the same way.
   *
   * The trigger swallows its refusals (it must never fail a proxy), so the ones
   * a run has to say out loud are read back from what it read. Waiting will not
   * fix a project with nobody to charge or no language to transcribe in — the
   * trigger refuses both without a word — so those are checked first; then
   * money, from the balance the hold would have come out of. A queue that is
   * down leaves the dead job row `JobsService.enqueue` writes behind. Anything
   * else — a full lane — is "not yet".
   */
  private async startTranscription(
    run: RepurposeRun,
    media: SourceMedia,
    project: SourceProject | null,
  ): Promise<TranscriptionStart> {
    if (
      project === null ||
      project.createdBy === null ||
      project.sourceLanguage === null ||
      project.sourceLanguage.trim() === ""
    ) {
      this.logger.warn(
        { runId: run.id, mediaId: media.id },
        "the source project has nobody to charge or no language; transcription cannot start",
      );
      return "cannot_start";
    }

    const attemptedAt = new Date();
    if ((await this.autoTranscribe.maybeEnqueue(media.id)) !== undefined) return "queued";

    // `finished_at`, not `queued_at`: the enqueue's failure path stamps it from
    // this process's clock, the same one `attemptedAt` came from.
    const [attempt] = await this.prisma.job.findMany({
      where: {
        projectId: run.sourceProjectId,
        type: "ai.transcribe",
        finishedAt: { gte: attemptedAt },
      },
      orderBy: { finishedAt: "desc" },
      take: 1,
      select: JOB_FIELDS,
    });
    if (refusedByQueue(factsOf(attempt))) {
      // The queue refused the add, which also means the credits were there:
      // the hold is reserved before the add and released after it.
      this.logger.warn(
        { runId: run.id, mediaId: media.id },
        "job queue is down; transcription waits",
      );
      return "queue_down";
    }

    if (media.durationMs !== null && media.durationMs > 0) {
      const account = await this.prisma.creditAccount.findUnique({
        where: { workspaceId: run.workspaceId },
        select: { balanceTenths: true },
      });
      if ((account?.balanceTenths ?? 0) < quoteTranscription(media.durationMs).tenths) {
        return "no_credits";
      }
    }
    this.logger.log(
      { runId: run.id, mediaId: media.id },
      "transcription not started yet; will retry",
    );
    return "deferred";
  }

  /** Everything {@link decideRunAction} reads, in one pass, as of `now`. */
  private async read(run: RepurposeRun, now: number = Date.now()): Promise<ReadState> {
    const [project, media, transcript, candidateCount] = await Promise.all([
      this.prisma.project.findUnique({
        where: { id: run.sourceProjectId },
        select: { deletedAt: true, createdBy: true, sourceLanguage: true },
      }),
      this.prisma.mediaAsset.findFirst({
        where: { projectId: run.sourceProjectId, role: "primary" },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          bucket: true,
          storageKey: true,
          status: true,
          failureReason: true,
          uploadedAt: true,
          durationMs: true,
          createdAt: true,
        },
      }),
      this.prisma.transcript.findFirst({
        where: { projectId: run.sourceProjectId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      }),
      this.prisma.clipCandidate.count({ where: { runId: run.id } }),
    ]);

    const newest = async (where: Prisma.JobWhereInput): Promise<JobRow[]> =>
      this.prisma.job.findMany({
        where,
        orderBy: { queuedAt: "desc" },
        take: JOB_LOOKBACK,
        select: JOB_FIELDS,
      });
    const none = async (): Promise<JobRow[]> => [];
    const preparing = media !== null && (media.status === "uploaded" || media.status === "probing");

    const [acquireJobs, processingJobs, transcribeJobs, highlightsJobs] = await Promise.all([
      run.sourceKind === "upload"
        ? none()
        : newest({
            workspaceId: run.workspaceId,
            type: "media.acquire",
            jobKey: { startsWith: `media.acquire:${run.id}:` },
          }),
      // Only asked while the media is being prepared: the one time a probe or
      // a proxy that ended can say something the media row does not.
      !preparing
        ? none()
        : newest({
            workspaceId: run.workspaceId,
            projectId: run.sourceProjectId,
            type: { in: ["media.probe", "media.proxy"] },
            jobKey: { in: [MEDIA_JOB_KEYS.probe(media.id), MEDIA_JOB_KEYS.proxy(media.id)] },
          }),
      media === null || transcript !== null
        ? none()
        : newest({ projectId: run.sourceProjectId, type: "ai.transcribe" }),
      transcript === null
        ? none()
        : newest({
            // The transcript is in the key: a newer transcript is a new discovery.
            workspaceId: run.workspaceId,
            type: "ai.highlights",
            jobKey: { startsWith: `ai.highlights:${run.id}:${transcript.id}:` },
          }),
    ]);

    // The address lives only in an acquire job's payload: the run row does not
    // keep it (§17.4). Any earlier fetch for this run will do.
    let refetchUrl: string | null = null;
    for (const job of acquireJobs) {
      const payload = MediaAcquirePayloadSchema.safeParse(job.params);
      if (payload.success) {
        refetchUrl = payload.data.source.normalizedUrl;
        break;
      }
    }
    // With no earlier job to read it from (job rows are pruned; a download
    // whose enqueue was refused never had one), a YouTube link is rebuilt from
    // its fingerprint - exactly the canonical form `parseSourceUrl` produces,
    // so nothing the person pasted is needed or stored.
    refetchUrl ??= youtubeUrlOf(run.sourceKind, run.sourceFingerprint);

    const forMedia = (jobs: readonly JobRow[]) =>
      media === null ? undefined : jobs.find((job) => paramOf(job, "mediaId") === media.id);

    const sourceDeleted = project === null || project.deletedAt !== null;
    return {
      media,
      project: sourceDeleted ? null : project,
      refetchUrl,
      snapshot: {
        now,
        sourceRequestedAt: (media?.createdAt ?? run.createdAt).getTime(),
        sourceKind: run.sourceKind,
        sourceDeleted,
        media:
          media === null
            ? null
            : {
                status: media.status,
                failureReason: media.failureReason,
                arrived: media.uploadedAt !== null,
                durationMs: media.durationMs,
              },
        acquireJob: factsOf(forMedia(acquireJobs)),
        processingJob: factsOf(processingJobs[0]),
        canRefetch: refetchUrl !== null,
        transcriptId: transcript?.id ?? null,
        transcribeJob: unansweredFactsOf(forMedia(transcribeJobs), run.updatedAt),
        highlightsJob: unansweredFactsOf(highlightsJobs[0], run.updatedAt),
        candidateCount,
      },
    };
  }

  /**
   * Clear a failure and put the run back at `status`. Null when someone else
   * already did.
   *
   * @throws 409 `repurpose/source_already_running` when the same link was
   *   started again in another run after `retry` checked: moving this one back
   *   into the live set then trips `repurpose_runs_live_source_idx`, which is
   *   the same refusal `create` gives, not a raw database conflict.
   */
  private async reopen(
    run: RepurposeRun,
    status: $Enums.RepurposeRunStatus,
  ): Promise<RepurposeRun | null> {
    let count: number;
    try {
      ({ count } = await this.prisma.repurposeRun.updateMany({
        where: { id: run.id, status: "failed" },
        data: {
          status,
          failureCode: null,
          completedAt: null,
          progress: progressForStatus(status),
          currentStage: stageForStatus(status),
        },
      }));
    } catch (error) {
      if (isUniqueViolation(error) && run.sourceFingerprint !== null) {
        throw (
          (await this.runs.duplicateOf(run.workspaceId, run.sourceFingerprint, run.id)) ?? error
        );
      }
      throw error;
    }
    if (count === 0) return null;
    const reopened = await this.current(run);
    await this.runs.publishStage(reopened);
    return reopened;
  }

  /** Undo {@link reopen}: the run is failed again, exactly as it was. */
  private async restoreFailure(reopened: RepurposeRun, original: RepurposeRun): Promise<void> {
    const { count } = await this.prisma.repurposeRun.updateMany({
      where: { id: reopened.id, status: reopened.status },
      data: {
        status: "failed",
        failureCode: original.failureCode,
        completedAt: original.completedAt,
        currentStage: original.currentStage,
        progress: original.progress,
      },
    });
    if (count > 0) await this.runs.publishStage(await this.current(original));
  }

  /**
   * Leave `runId` alone on reads for {@link QUEUE_DOWN_BACKOFF_MS}: its last
   * enqueue was refused by the queue itself, and every retry while it is down
   * writes another dead job row. Completions and retries still reconcile it.
   */
  private backOff(runId: string, now: number = Date.now()): void {
    this.reconciledAt.set(runId, now + QUEUE_DOWN_BACKOFF_MS - RECONCILE_INTERVAL_MS);
  }

  private async current(run: RepurposeRun): Promise<RepurposeRun> {
    return (await this.prisma.repurposeRun.findUnique({ where: { id: run.id } })) ?? run;
  }

  private stamp(runId: string, now: number): void {
    if (this.reconciledAt.size >= STAMP_PRUNE_AT) {
      for (const [id, at] of this.reconciledAt) {
        if (now - at >= RECONCILE_INTERVAL_MS) this.reconciledAt.delete(id);
      }
    }
    this.reconciledAt.set(runId, now);
  }
}

/** The job queue refused an enqueue (`JobsService.enqueue` answers 503 `common/unavailable`). */
function isQueueDown(error: unknown): boolean {
  return error instanceof AppException && error.code === ERROR_CODES.unavailable;
}

function isSettled(status: $Enums.RepurposeRunStatus): boolean {
  return (SETTLED_RUN_STATUSES as readonly string[]).includes(status);
}

function isPreCandidate(status: $Enums.RepurposeRunStatus): boolean {
  return (PRE_CANDIDATE_STATUSES as readonly string[]).includes(status);
}

/** The canonical watch URL for a YouTube run's `youtube:{videoId}` fingerprint. */
export function youtubeUrlOf(kind: string, fingerprint: string | null): string | null {
  if (kind !== "youtube_url" || fingerprint === null) return null;
  const match = /^youtube:([\w-]{11})$/.exec(fingerprint);
  return match === null ? null : `https://www.youtube.com/watch?v=${match[1] ?? ""}`;
}
