import { HttpStatus, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { MediaAcquirePayloadSchema } from "@montaj/repurpose-contracts";

import {
  LEGACY_RUN_FAILURE_CODES,
  STAGE_OF_FAILURE,
  jobErrorCodeOf,
  runFailureCode,
} from "./failure-codes.js";
import { RepurposeClipsService } from "./repurpose-clips.service.js";
import {
  PRE_CANDIDATE_STATUSES,
  QUEUE_DOWN_BACKOFF_MS,
  RECONCILE_INTERVAL_MS,
  REPURPOSE_ERRORS,
  SETTLED_RUN_STATUSES,
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
 * run) and at the end of every completion that concerns one, so nothing needs
 * a scheduler. It is idempotent: every enqueue it makes dedupes on its job key,
 * and every write is conditional on the run still being where it was read.
 */

/** Enough of one job to tell live, finished and failed apart. */
export interface JobFacts {
  readonly status: $Enums.JobStatus;
  readonly errorCode: string | null;
  /** A worker picked it up (`started_at` is set). */
  readonly started: boolean;
}

/** Everything the decision reads, as plain data, so the decision is a pure function. */
export interface RunSnapshot {
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

function fail(failedAt: FailedAt, mediaReason: string | null, jobErrorCode: string | null) {
  return {
    kind: "fail",
    failedAt,
    code: runFailureCode({ failedAt, mediaReason, jobErrorCode }),
  } as const;
}

/**
 * The media arrived, and the step preparing it — the probe or the proxy —
 * ended without it. The proxy's failure handler marks the media failed; the
 * probe has none, so a probe that failed (or a media PATCH that never landed)
 * leaves the media `uploaded` or `probing` for good.
 */
function preparationEnded(snapshot: RunSnapshot): JobFacts | null {
  const status = snapshot.media?.status;
  if (status !== "uploaded" && status !== "probing") return null;
  const job = presentJob(snapshot.processingJob);
  return job !== null && isOver(job) ? job : null;
}

/** The source project is gone: the run fails as a video we no longer have. */
const SOURCE_GONE: RunAction = {
  kind: "fail",
  failedAt: "acquire",
  code: "repurpose/source_unavailable",
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
    return WAIT;
  }

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
    // Queued or running, or succeeded with the hand-off to probing in flight.
    return WAIT;
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
      return ended === null ? WAIT : fail("processing", media.failureReason, ended.errorCode);
    }
  }
  if (media.durationMs === null || media.durationMs <= 0) return WAIT;

  const job = presentJob(snapshot.transcribeJob);
  if (job === null) return { kind: "transcribe" };
  if (isOver(job)) return fail("transcription", null, job.errorCode);
  // Queued or running, or succeeded with the transcript still being written.
  return WAIT;
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
      !isOver(fetching)
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
  if (media?.status === "failed" || preparationEnded(snapshot) !== null) {
    return {
      kind: "impossible",
      reason: "This file could not be read. Upload it again, or choose another video.",
    };
  }
  // An upload still arriving, or being prepared: nothing to restart, only a
  // failure to clear.
  return { kind: "resume" };
}

interface JobRow {
  readonly status: $Enums.JobStatus;
  readonly error: Prisma.JsonValue | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly params: Prisma.JsonValue;
}

function factsOf(job: JobRow | undefined | null): JobFacts | null {
  if (job === undefined || job === null) return null;
  return {
    status: job.status,
    errorCode: jobErrorCodeOf(job.error),
    started: job.startedAt !== null,
  };
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
  status: true,
  error: true,
  startedAt: true,
  finishedAt: true,
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
export class RepurposeReconciler implements RunReconciler, OnModuleInit {
  private readonly logger = new Logger(RepurposeReconciler.name);
  private readonly reconciledAt = new Map<string, number>();

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
   * @throws 409 when there is no stage a retry can restart (an upload that could
   *   not be read, a deleted project), or when the link has been started again
   *   in another run meanwhile (`repurpose/source_already_running`).
   */
  async redrive(run: RepurposeRun): Promise<RepurposeRun> {
    const state = await this.read(run);
    const plan = planRetry(state.snapshot, { failureCode: run.failureCode });

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

    const state = await this.read(run);
    const action = decideRunAction(state.snapshot);
    switch (action.kind) {
      case "wait":
        return run;

      case "fail": {
        const failed = await this.runs.failRun(run, action.code, STAGE_OF_FAILURE[action.failedAt]);
        return failed ?? this.current(run);
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

  /** Everything {@link decideRunAction} reads, in one pass. */
  private async read(run: RepurposeRun): Promise<ReadState> {
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
