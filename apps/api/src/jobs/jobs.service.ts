import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";

import { TENTHS_PER_CREDIT } from "@montaj/config";

import { AdmissionService, IN_FLIGHT_STATUSES } from "./admission.service.js";
import { JobCompletionRegistry } from "./completion-handlers.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";
import { buildJobEnvelope } from "./contracts/job-envelope.js";
import { isQueueName, queueForJobType } from "./contracts/queue-names.js";
import { DlqService } from "./dlq.service.js";
import { jobUlid } from "./ids.js";
import { JobEventsService } from "./job-events.service.js";
import { JOBS_MAX_PAGE_SIZE, JOBS_PAGE_SIZE } from "./jobs.config.js";
import { JOB_ERROR_CODES } from "./jobs.errors.js";
import { QueueRegistry, bullJobId } from "./queue.registry.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { MetricsService } from "../common/metrics/metrics.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { CREDITS_FACADE } from "../credits/credits.facade.js";
import { NotifyService } from "../notify/notify.service.js";

import type { JobCompletionOutcome } from "./completion-handlers.js";
import type { CreditsFacade, SettleResult } from "../credits/credits.facade.js";
import type { CallbackAck, JobCompletion, JobProgress, JobUsage } from "./contracts/completion.js";
import type { JobEnvelope } from "./contracts/job-envelope.js";
import type { Job, JobStatus, Prisma } from "@prisma/client";

export interface EnqueueJobInput {
  /** One of the CONTRACTS §3 queue names. */
  readonly type: string;
  readonly workspaceId: string;
  readonly projectId?: string | null;
  /** The queue payload for `type`; its shape belongs to the job type's owner. */
  readonly params?: Record<string, unknown>;
  /** Override the plan's priority. Lower runs first; omit to use the plan lane. */
  readonly priority?: number;
  /** One live job per (workspace, unit of work). */
  readonly jobKey: string;
  /** Worst-case cost in tenths, held before the job is enqueued (CONTRACTS §4). */
  readonly worstCaseTenths: number;
  /** Credit audit trail, e.g. `"ai.transcribe · 12.4 media minutes"`. */
  readonly reason?: string;
  /**
   * Take the plan's priority and queue-wait budget but check neither cap.
   *
   * Only for the second half of a piece of work the workspace was already
   * admitted for — `media.probe` asking for its `media.proxy` (A07). It is
   * deliberately absent from `EnqueueChildSchema`, so nothing a worker can send
   * reaches it (THREAT-MODEL T23).
   */
  readonly skipAdmission?: boolean;
}

export interface EnqueueResult {
  readonly job: Job;
  /** True when an identical live job already existed and this call enqueued nothing. */
  readonly deduplicated: boolean;
}

export interface ListJobsInput {
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly status?: JobStatus;
  readonly type?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, or `null` at the end. */
  readonly nextCursor: string | null;
}

const TERMINAL_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "cancelled"];

/**
 * The producer side of every queue in CONTRACTS §3, and the state machine behind
 * `jobs`.
 *
 * The order of operations in {@link enqueue} is the whole design:
 *
 * ```
 * dedupe by jobKey → admission (T23) → jobs row → CreditsFacade.reserve (T9)
 *   → BullMQ add → job_events
 * ```
 *
 * The row exists before the reservation because a hold is keyed on a job id, and
 * the BullMQ job is added last because that is the only step a consumer can see:
 * every earlier failure unwinds with nothing enqueued, and a failure at the last
 * step releases the hold and fails the row. A job that reaches Redis therefore
 * always has a row and a hold behind it.
 *
 * Completion is idempotent on `(jobId, attemptId)` (THREAT-MODEL T8) and settles
 * exactly once, because the settle is gated on a conditional `UPDATE ... WHERE
 * status IN ('queued','running')` that only one caller can win.
 *
 * A08b adds the far end of that path: when the failure is the *last* attempt, the
 * job is copied into `dlq` and marked, and an admin can replay it with a fresh
 * attempt or discard it and release the hold ({@link DlqService}).
 */
@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly admission: AdmissionService,
    private readonly events: JobEventsService,
    private readonly realtime: RealtimePublisher,
    private readonly dlq: DlqService,
    private readonly metrics: MetricsService,
    private readonly completionHandlers: JobCompletionRegistry,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
    private readonly notify: NotifyService,
  ) {}

  // -------------------------------------------------------------------------
  // Producing
  // -------------------------------------------------------------------------

  async enqueue(input: EnqueueJobInput): Promise<EnqueueResult> {
    const type = input.type;
    if (!isQueueName(type)) {
      throw new AppException(
        JOB_ERROR_CODES.invalidType,
        `"${type}" is not a queue in CONTRACTS §3.`,
        HttpStatus.BAD_REQUEST,
        { type },
      );
    }

    const existing = await this.findLiveByKey(input.workspaceId, input.jobKey);
    if (existing !== null) return { job: existing, deduplicated: true };

    const limits =
      input.skipAdmission === true
        ? await this.admission.limitsFor(input.workspaceId)
        : (
            await this.admission.admit({
              workspaceId: input.workspaceId,
              worstCaseTenths: input.worstCaseTenths,
            })
          ).limits;
    const priority = input.priority ?? limits.priority;

    const jobId = jobUlid();
    const attemptId = jobUlid();
    const params = input.params ?? {};

    let job: Job;
    try {
      job = await this.prisma.job.create({
        data: {
          id: jobId,
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? null,
          type,
          status: "queued",
          priority,
          params: params as Prisma.InputJsonValue,
          jobKey: input.jobKey,
          attemptId,
          attemptNo: 1,
          maxQueueWaitMs: limits.maxQueueWaitMs,
          // The worst-case hold, which the completion path overwrites with the
          // settled amount. Admission control sums this column.
          creditsChargedTenths: input.worstCaseTenths,
        },
      });
    } catch (error) {
      // The `findLiveByKey` above is a read, and a read cannot exclude a writer
      // that commits a microsecond later. `jobs_live_workspace_job_key_key`
      // (prisma/sql/0005-a08b-dlq.sql) is the actual guarantee: UNIQUE
      // (workspace_id, job_key) WHERE status IN ('queued','running'). Losing that
      // race means the caller asked for a job that now exists, which is exactly
      // what dedupe promises — so return the winner rather than a 500.
      const existingNow = isUniqueViolation(error)
        ? await this.findLiveByKey(input.workspaceId, input.jobKey)
        : null;
      if (existingNow !== null) return { job: existingNow, deduplicated: true };
      throw error;
    }

    let holdId: string;
    try {
      const hold = await this.credits.reserve({
        workspaceId: input.workspaceId,
        jobId,
        worstCaseTenths: input.worstCaseTenths,
        reason: input.reason ?? `${type} · ${input.jobKey}`,
      });
      holdId = hold.holdId;
    } catch (error) {
      // Nothing was enqueued and nothing was held, so the row must not linger and
      // count against the next admission check.
      await this.prisma.job.delete({ where: { id: jobId } }).catch(() => undefined);
      throw error;
    }

    await this.prisma.job.update({ where: { id: jobId }, data: { creditHoldId: holdId } });

    const envelope = buildJobEnvelope({
      jobId,
      attemptId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      priority,
      jobKey: input.jobKey,
      createdAt: job.queuedAt,
      payload: params,
    });

    try {
      await this.queues
        .queue(queueForJobType(type))
        .add(
          type,
          envelope,
          this.queues.optionsFor({ queueName: type, jobId, attemptId, priority }),
        );
    } catch (error) {
      await this.credits.release({ holdId });
      await this.prisma.job.update({
        where: { id: jobId },
        data: {
          status: "failed",
          finishedAt: new Date(),
          creditsChargedTenths: 0,
          error: { code: ERROR_CODES.unavailable, message: "Queue unavailable.", retryable: true },
        },
      });
      throw new AppException(
        ERROR_CODES.unavailable,
        "The job queue is unavailable; please retry.",
        HttpStatus.SERVICE_UNAVAILABLE,
        { jobId, cause: describe(error) },
      );
    }

    await this.events.append({
      jobId,
      name: "job.queued",
      message: `queued on ${type}`,
      data: {
        type,
        priority,
        attemptId,
        holdId,
        worstCaseTenths: input.worstCaseTenths,
        maxQueueWaitMs: limits.maxQueueWaitMs,
        plan: limits.plan,
      },
    });

    return { job: { ...job, creditHoldId: holdId }, deduplicated: false };
  }

  /** The envelope a job was (or would be) enqueued with. Diagnostics and tests. */
  envelopeFor(job: Job): JobEnvelope {
    return buildJobEnvelope({
      jobId: job.id,
      attemptId: job.attemptId ?? job.id,
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      priority: job.priority,
      jobKey: job.jobKey,
      createdAt: job.queuedAt,
      payload: (job.params ?? {}) as Record<string, unknown>,
    });
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** @throws AppException 404 when the job is missing or in another workspace (T5). */
  async get(jobId: string, workspaceId: string): Promise<Job> {
    const job = await this.prisma.job.findFirst({ where: { id: jobId, workspaceId } });
    if (job === null) {
      throw new AppException(JOB_ERROR_CODES.notFound, "No such job.", HttpStatus.NOT_FOUND, {
        jobId,
      });
    }
    return job;
  }

  async list(input: ListJobsInput): Promise<Page<Job>> {
    const take = clampLimit(input.limit);
    const items = await this.prisma.job.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.type === undefined ? {} : { type: input.type }),
      },
      // ULIDs sort lexicographically by creation time, so the id alone is a stable
      // cursor — no (timestamp, id) tuple and no ties to break.
      orderBy: { id: "desc" },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: take + 1,
    });
    return page(items, take, (job) => job.id);
  }

  async listEvents(
    jobId: string,
    workspaceId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<Page<{ id: string; at: Date; level: string; message: string; data: unknown }>> {
    await this.get(jobId, workspaceId);
    const take = clampLimit(options.limit);
    const rows = await this.prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { id: "asc" },
      ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      take: take + 1,
    });
    return page(rows, take, (row) => row.id);
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  async cancel(jobId: string, workspaceId: string): Promise<Job> {
    const job = await this.get(jobId, workspaceId);
    if (TERMINAL_STATUSES.includes(job.status)) {
      throw new AppException(
        JOB_ERROR_CODES.invalidState,
        `A ${job.status} job cannot be cancelled.`,
        HttpStatus.CONFLICT,
        { jobId, status: job.status },
      );
    }

    const { count } = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: [...IN_FLIGHT_STATUSES] } },
      data: {
        status: "cancelled",
        finishedAt: new Date(),
        creditsChargedTenths: 0,
        error: { code: "jobs/cancelled", message: "Cancelled by the workspace.", retryable: false },
      },
    });
    if (count === 0) {
      throw new AppException(
        JOB_ERROR_CODES.invalidState,
        "The job finished before it could be cancelled.",
        HttpStatus.CONFLICT,
        { jobId },
      );
    }

    await this.removeFromQueue(job);
    if (job.creditHoldId !== null) await this.credits.release({ holdId: job.creditHoldId });

    this.metrics.jobCompleted({ queue: job.type, status: "cancelled", attempt: job.attemptNo });
    await this.events.append({ jobId, name: "job.cancelled", message: "cancelled" });
    await this.realtime.jobCompleted(job, { jobId, status: "cancelled", type: job.type });

    return this.get(jobId, workspaceId);
  }

  /**
   * Worker progress (`POST /internal/jobs/{id}/progress`).
   *
   * Also the heartbeat that A08b extends a long ASR job's lock with, which is why
   * a progress call on a `queued` job promotes it to `running`.
   */
  async recordProgress(jobId: string, attemptId: string, body: JobProgress): Promise<CallbackAck> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (job === null) {
      throw new AppException(JOB_ERROR_CODES.notFound, "No such job.", HttpStatus.NOT_FOUND, {
        jobId,
      });
    }

    const stale = this.staleReason(job, attemptId);
    if (stale !== undefined) return { applied: false, jobId, status: job.status, reason: stale };

    const starting = job.status === "queued";
    if (starting) {
      // First progress call IS first pickup: METRICS.md §2
      // `montaj.queue.wait.duration` is "enqueue to first pickup", and this is the
      // only moment the API learns a worker has the job.
      this.metrics.queueWait(job.type, Date.now() - job.queuedAt.getTime());
    }
    await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: [...IN_FLIGHT_STATUSES] } },
      data: {
        status: "running",
        progress: Math.round(body.progress),
        etaMs: body.etaMs ?? null,
        ...(job.startedAt === null ? { startedAt: new Date() } : {}),
      },
    });

    if (starting) {
      await this.events.append({ jobId, name: "job.started", message: "started" });
    }
    await this.events.append({
      jobId,
      name: "job.progress",
      level: "debug",
      message: body.message ?? `progress ${String(Math.round(body.progress))}%`,
      data: { progress: body.progress, etaMs: body.etaMs ?? null },
    });
    await this.realtime.jobProgress(job, {
      jobId,
      progress: body.progress,
      ...(body.etaMs === undefined ? {} : { etaMs: body.etaMs }),
      ...(body.message === undefined ? {} : { message: body.message }),
    });

    return { applied: true, jobId, status: "running" };
  }

  /**
   * Worker completion (`POST /internal/jobs/{id}/complete`).
   *
   * Idempotent by construction: the state change is a conditional `updateMany`
   * that only a job still in `queued`/`running` can satisfy, so a replay — or two
   * workers racing — finds zero rows, skips the settlement entirely and answers
   * 200 with `applied: false`. Nothing is settled twice (THREAT-MODEL T8/T9).
   */
  async complete(jobId: string, attemptId: string, body: JobCompletion): Promise<CallbackAck> {
    const job = await this.prisma.job.findUnique({ where: { id: jobId } });
    if (job === null) {
      throw new AppException(JOB_ERROR_CODES.notFound, "No such job.", HttpStatus.NOT_FOUND, {
        jobId,
      });
    }

    const stale = this.staleReason(job, attemptId);
    if (stale !== undefined) return { applied: false, jobId, status: job.status, reason: stale };

    const succeeded = body.status === "succeeded";
    const usage = body.usage;

    // The job type's own handler runs BEFORE the status flip, so a failure leaves
    // the job `running` and the worker's retry re-drives it. Handlers are
    // idempotent by contract (`completion-handlers.ts`), which is what makes
    // re-driving safe.
    const outcome = succeeded ? await this.runCompletionHandler(job, attemptId, body) : undefined;
    const requestedTenths = succeeded ? settlementTenths(job, usage, outcome?.actualTenths) : 0;

    // Settled BEFORE the job row's own status-flip CAS below, not after:
    // `CreditsFacade.settle` is independently idempotent (a claim-first CAS on
    // `credit_holds.status`), so a caller that goes on to lose the job-row race
    // has done no harm, and the job row needs `settle`'s real answer to record a
    // true `creditsChargedTenths` — B02b: that column is a denormalised display
    // copy of what the ledger actually settled, never of what was merely asked
    // for (the authoritative in-flight figure for admission control is the sum
    // of open `credit_holds`, apps/api/src/credits/README.md).
    let settleResult: SettleResult | undefined;
    if (succeeded && job.creditHoldId !== null) {
      settleResult = await this.credits.settle({
        holdId: job.creditHoldId,
        actualTenths: requestedTenths,
      });
    }
    const settledTenths = settleResult?.settledTenths ?? requestedTenths;
    // CONTRACTS §4's frozen `SettleResult` carries no explicit flag: a shortfall
    // with no delta hold IS `needs_credits` (D32 — "settle what is held and
    // return needs_credits").
    const needsCredits =
      settleResult !== undefined &&
      settleResult.settledTenths < requestedTenths &&
      settleResult.deltaHoldId === undefined;
    const shortfallTenths = needsCredits ? requestedTenths - settledTenths : 0;

    const resultPayload = needsCredits
      ? {
          ...((body.result as Record<string, unknown> | undefined) ?? {}),
          creditsShortfallTenths: shortfallTenths,
        }
      : body.result;

    const { count } = await this.prisma.job.updateMany({
      where: { id: jobId, status: { in: [...IN_FLIGHT_STATUSES] } },
      data: {
        status: succeeded ? "succeeded" : "failed",
        finishedAt: new Date(),
        progress: succeeded ? 100 : job.progress,
        etaMs: null,
        creditsChargedTenths: succeeded ? settledTenths : 0,
        ...(resultPayload === undefined ? {} : { result: resultPayload as Prisma.InputJsonValue }),
        ...(body.error === undefined ? {} : { error: body.error as Prisma.InputJsonValue }),
        ...(usage?.provider === undefined ? {} : { provider: usage.provider }),
        ...(usage?.model === undefined ? {} : { model: usage.model }),
        ...(usage?.costMinor === undefined ? {} : { costMinor: usage.costMinor }),
        ...(usage?.egressBytes === undefined ? {} : { egressBytes: BigInt(usage.egressBytes) }),
      },
    });

    if (count === 0) {
      // Lost the race, or this is a replay of a call that already won it.
      return { applied: false, jobId, status: job.status, reason: "already_completed" };
    }

    if (!succeeded && job.creditHoldId !== null) {
      await this.credits.release({ holdId: job.creditHoldId });
    }

    const status: "succeeded" | "failed" = succeeded ? "succeeded" : "failed";
    await this.events.append({
      jobId,
      name: succeeded ? "job.succeeded" : "job.failed",
      level: succeeded ? "info" : "error",
      message: succeeded ? "succeeded" : (body.error?.message ?? "failed"),
      data: {
        settledTenths,
        ...(usage === undefined ? {} : { usage }),
        ...(body.error === undefined ? {} : { error: body.error }),
        ...(outcome?.data === undefined ? {} : outcome.data),
      },
    });

    if (needsCredits) {
      await this.events.append({
        jobId,
        name: "job.needs_credits",
        level: "warn",
        message: `settled ${String(settledTenths)} of ${String(requestedTenths)} tenths; the workspace is short ${String(shortfallTenths)}`,
        data: { requestedTenths, settledTenths, shortfallTenths },
      });
      await this.notifyCreditsShortfall(job, shortfallTenths);
    }

    this.metrics.jobCompleted({
      queue: job.type,
      status,
      attempt: job.attemptNo,
    });
    if (!succeeded) await this.markDeadLetterIfFinal(job, body);

    await this.realtime.jobCompleted(job, {
      jobId,
      status,
      type: job.type,
      ...(body.error === undefined
        ? {}
        : { error: { code: body.error.code, message: body.error.message } }),
    });

    return { applied: true, jobId, status };
  }

  /**
   * Fail a job that waited longer than its plan's `maxQueueWaitMs` and give the
   * credits back (`jobs/queue_timeout`, THREAT-MODEL T23). Driven by the scheduled
   * task in `tasks/queue-timeout.task.ts`.
   */
  async timeOut(job: Job): Promise<boolean> {
    const { count } = await this.prisma.job.updateMany({
      where: { id: job.id, status: "queued" },
      data: {
        status: "failed",
        finishedAt: new Date(),
        creditsChargedTenths: 0,
        error: {
          code: JOB_ERROR_CODES.queueTimeout,
          message: `Waited longer than ${String(job.maxQueueWaitMs ?? 0)} ms for a worker.`,
          retryable: true,
        },
      },
    });
    if (count === 0) return false;

    await this.removeFromQueue(job);
    if (job.creditHoldId !== null) await this.credits.release({ holdId: job.creditHoldId });

    this.metrics.jobCompleted({ queue: job.type, status: "expired", attempt: job.attemptNo });
    await this.events.append({
      jobId: job.id,
      name: "job.timed_out",
      level: "warn",
      message: "queue wait exceeded",
      data: { maxQueueWaitMs: job.maxQueueWaitMs, waitedMs: Date.now() - job.queuedAt.getTime() },
    });
    await this.realtime.jobCompleted(job, {
      jobId: job.id,
      status: "failed",
      type: job.type,
      error: {
        code: JOB_ERROR_CODES.queueTimeout,
        message: "The job waited too long for a worker.",
      },
    });
    return true;
  }

  /**
   * A follow-up a worker asks for (`POST /internal/jobs/{id}/enqueue-child`), such
   * as `media.probe` deciding a proxy is needed.
   *
   * The child inherits the parent's workspace and project — never the caller's
   * word for them — so a compromised worker cannot enqueue into another tenant
   * (THREAT-MODEL T4).
   */
  async enqueueChild(
    parent: Job,
    input: {
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly worstCaseTenths: number;
      readonly jobKey?: string;
      readonly reason?: string;
      /** API-side callers only; see {@link EnqueueJobInput.skipAdmission}. */
      readonly skipAdmission?: boolean;
    },
  ): Promise<EnqueueResult> {
    const jobKey = input.jobKey ?? `${parent.jobKey}:${input.type}`;
    const result = await this.enqueue({
      type: input.type,
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      params: input.payload,
      priority: parent.priority,
      jobKey,
      worstCaseTenths: input.worstCaseTenths,
      reason: input.reason ?? `child of ${parent.id}`,
      ...(input.skipAdmission === undefined ? {} : { skipAdmission: input.skipAdmission }),
    });

    await this.events.append({
      jobId: parent.id,
      name: "job.child_enqueued",
      message: `enqueued ${input.type}`,
      data: {
        childJobId: result.job.id,
        type: input.type,
        deduplicated: result.deduplicated,
      },
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async findLiveByKey(workspaceId: string, jobKey: string): Promise<Job | null> {
    return this.prisma.job.findFirst({
      where: { workspaceId, jobKey, status: { in: [...IN_FLIGHT_STATUSES] } },
      orderBy: { id: "desc" },
    });
  }

  /** `undefined` when the callback may proceed, otherwise why it may not. */
  private staleReason(job: Job, attemptId: string): string | undefined {
    if (job.attemptId !== null && job.attemptId !== attemptId) return "stale_attempt";
    if (TERMINAL_STATUSES.includes(job.status)) return "already_completed";
    return undefined;
  }

  /**
   * Hand the payload to whichever module owns this queue's completions.
   *
   * Called before the conditional `UPDATE`, so it is the handler — not the state
   * machine — that decides whether the job may be called done. A throw is
   * deliberately not swallowed: the callback answers 5xx, the job stays
   * `running`, and the worker's next delivery runs the handler again against a
   * job that is still open. The alternative (flip first, persist after) turns the
   * first transient database error into permanent data loss, because the replay
   * would be answered `already_completed` before the handler was ever reached.
   */
  private async runCompletionHandler(
    job: Job,
    attemptId: string,
    body: JobCompletion,
  ): Promise<JobCompletionOutcome | undefined> {
    const handler = this.completionHandlers.handlerFor(job.type);
    if (handler === undefined) return undefined;

    try {
      return await handler.handle({
        job,
        attemptId,
        result: (body.result ?? {}) as Record<string, unknown>,
        usage: body.usage,
        completion: body,
      });
    } catch (error) {
      this.logger.error(
        { jobId: job.id, queue: job.type, err: describe(error) },
        "completion handler failed; the job stays open for the worker to retry",
      );
      await this.events
        .append({
          jobId: job.id,
          name: "job.completion_handler_failed",
          level: "error",
          message: describe(error),
          data: { type: job.type },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * The last attempt failed: copy the job into `dlq` and mark the row (A08b).
   *
   * "Final" is the worker's word for it — BullMQ sets `finalAttempt` when the
   * retry budget is spent — or an error the worker has declared unretryable, which
   * skips the remaining attempts because retrying a corrupt upload three times is
   * three times the wait for the same answer.
   *
   * `job` is the row as it was BEFORE the completion update, which is what makes
   * the copy useful: it still carries the credit hold a later replay reserves
   * against.
   */
  private async markDeadLetterIfFinal(job: Job, body: JobCompletion): Promise<void> {
    const final = body.finalAttempt === true || body.error?.retryable === false;
    if (!final) return;
    try {
      await this.dlq.record(job, body);
    } catch (error) {
      // A dead letter that cannot be recorded must still be visible: the job is
      // already `failed` and the credits are already released, so losing the row
      // costs an operator the replay, not the user their money.
      this.logger.error(
        { jobId: job.id, queue: job.type, err: describe(error) },
        "dead letter not recorded",
      );
    }
  }

  /**
   * `needs_credits` (B02b): the ledger could not fully settle this job. A
   * notification is a side effect of an outcome that is already durable — the
   * row and the `job.needs_credits` event are already written — so a Redis or
   * `notify` outage here is logged and swallowed rather than failing the
   * completion callback the worker is waiting on (mirrors
   * `RealtimePublisher`/`WorkspaceNotifier`/`CreditsLowBalanceNotifier`, which
   * make the same call for the same reason).
   */
  private async notifyCreditsShortfall(job: Job, shortfallTenths: number): Promise<void> {
    try {
      const [workspace, account] = await Promise.all([
        this.prisma.workspace.findFirst({
          where: { id: job.workspaceId, deletedAt: null },
          select: { owner: { select: { id: true, email: true, name: true, locale: true } } },
        }),
        this.prisma.creditAccount.findUnique({
          where: { workspaceId: job.workspaceId },
          select: { balanceTenths: true },
        }),
      ]);
      if (workspace === null) return;

      await this.notify.enqueue({
        kind: "low-credits",
        to: workspace.owner.email,
        locale: workspace.owner.locale,
        userId: workspace.owner.id,
        workspaceId: job.workspaceId,
        data: {
          name: workspace.owner.name ?? "there",
          minutes: Math.max(0, Math.floor((account?.balanceTenths ?? 0) / TENTHS_PER_CREDIT)),
          // Not read by the "low-credits" template's ICU vars (`name`,
          // `minutes`) — carried anyway so the notification payload itself
          // names what triggered it, for anything that later reads
          // `notifications.data` (the admin console, a future template).
          shortfallTenths,
        },
        // One notification per job's shortfall, not one per retried callback —
        // a stale replay never reaches here at all (`staleReason` catches it
        // before this method is in play), but the key still guards a genuine
        // concurrent double-completion from paging a workspace twice.
        idempotencyKey: `low-credits:job:${job.id}`,
      });
    } catch (error) {
      this.logger.warn(
        { err: describe(error), jobId: job.id, workspaceId: job.workspaceId },
        "credits shortfall notification not sent",
      );
    }
  }

  /** Best effort: a job already picked up, or already gone, is not an error. */
  private async removeFromQueue(job: Job): Promise<void> {
    if (!isQueueName(job.type) || job.attemptId === null) return;
    try {
      const queue = this.queues.queue(job.type);
      const entry = await queue.getJob(bullJobId(job.id, job.attemptId));
      await entry?.remove();
    } catch (error) {
      this.logger.debug({ jobId: job.id, err: describe(error) }, "queue entry not removed");
    }
  }
}

/**
 * What to settle: the worker's own figure when it reported one, otherwise the
 * full hold. Deliberately NOT capped at the hold any more (B02b): an over-run is
 * `CreditsFacade.settle`'s delta-hold problem now that the real ledger exists,
 * and capping here would mean it never sees the true figure and never raises the
 * delta charge — or the `needs_credits` shortfall — CONTRACTS §4 promises.
 */
function settlementTenths(
  job: Job,
  usage: JobUsage | undefined,
  fromHandler: number | undefined,
): number {
  const held = job.creditsChargedTenths;
  // The handler's figure wins over the worker's: it was computed from the rows
  // that actually landed, not from what the worker believed it produced.
  const reported = fromHandler ?? usage?.actualTenths;
  if (reported === undefined) return held;
  return Math.max(0, Math.round(reported));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return JOBS_PAGE_SIZE;
  return Math.min(JOBS_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function page<T>(rows: T[], take: number, id: (row: T) => string): Page<T> {
  if (rows.length <= take) return { items: rows, nextCursor: null };
  const items = rows.slice(0, take);
  const last = items[items.length - 1];
  return { items, nextCursor: last === undefined ? null : id(last) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Is this Prisma's "unique constraint failed" (P2002)?
 *
 * Matched structurally rather than with `instanceof
 * Prisma.PrismaClientKnownRequestError`, because the generated client is a runtime
 * value and importing it for a type guard would drag the whole client into every
 * unit test that stubs Prisma out.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
