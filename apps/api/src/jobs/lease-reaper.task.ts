import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";

import { JobCompletionSchema } from "./contracts/completion.js";
import { isQueueName, queueForJobType } from "./contracts/queue-names.js";
import { heartbeatIntervalMs } from "./jobs.config.js";
import { JOB_ERROR_CODES } from "./jobs.errors.js";
import { JobsService } from "./jobs.service.js";
import { QueueRegistry, bullJobId } from "./queue.registry.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";
import { InternalMediaController, MediaPatchDto } from "../internal/internal-media.controller.js";

import type { JobCompletion, JobError } from "./contracts/completion.js";
import type { QueueName } from "./contracts/queue-names.js";
import type { JobState } from "bullmq";

/** The scheduled task's name; also its BullMQ scheduler key. */
export const LEASE_REAPER_TASK = "jobs.lease-reaper";

/** Every minute: the shortest silence it acts on is 30 s (`notify`), the usual one ten minutes. */
export const LEASE_REAPER_INTERVAL_MS = 60_000;

/**
 * Missed heartbeats before a job counts as silent. Three, because the heartbeat is
 * already a third of the lock (`heartbeatIntervalMs`), so three missed beats is
 * the whole lock gone with nothing renewing it.
 */
export const LEASE_REAPER_MISSED_BEATS = 3;

/** Running rows read per pass. Far above anything this deployment runs at once. */
export const LEASE_REAPER_SCAN = 500;

/** Jobs settled per pass, so a backlog of zombies drains over a few ticks. */
export const LEASE_REAPER_BATCH = 50;

/** The error a reaped job is failed with. Only the reaper produces it. */
export const JOB_STALLED_CODE = JOB_ERROR_CODES.stalled;

/**
 * What the person sees. `JobsService.complete` sends the message to the browser
 * (realtime) and to outgoing webhooks, so it is written for them; the numbers an
 * operator wants are in `facts`.
 */
export const JOB_STALLED_MESSAGE =
  "This step stopped responding and was stopped. You can try it again.";

/**
 * BullMQ states in which the job will still run or report: a worker holds it
 * (`active`), or it is waiting for one — including a retry in backoff, which is
 * also how worker-media carries a completion the API never heard to its next
 * attempt (`runtime.ts`, "an outcome the API never heard is carried").
 * Everything else — `completed`, `failed`, or no such job at all — means
 * nothing will ever report on this row again.
 */
const LIVE_STATES: ReadonlySet<JobState | "unknown"> = new Set<JobState | "unknown">([
  "active",
  "waiting",
  "delayed",
  "prioritized",
  "waiting-children",
]);

/** States in which the job's data may still hold an outcome its worker could not deliver. */
const FINISHED_STATES: ReadonlySet<JobState | "unknown"> = new Set<JobState | "unknown">([
  "completed",
  "failed",
]);

/**
 * worker-media's `pendingOutcome` (`runtime.ts`): the exact bodies an attempt
 * would have sent, kept in the BullMQ job's data when the API could not be
 * reached. Parsed, never trusted: Redis is a worker's scratch space.
 */
const CarriedOutcomeSchema = z.object({
  attemptId: z.string().min(1),
  mediaPatch: z.record(z.string(), z.unknown()).optional(),
  completion: JobCompletionSchema,
});

type CarriedOutcome = z.infer<typeof CarriedOutcomeSchema>;

interface Candidate {
  readonly id: string;
  readonly type: QueueName;
  /** `running`, or `queued` whose attempt BullMQ already finished ({@link LeaseReaperTask}). */
  readonly status: "queued" | "running";
  readonly attemptId: string | null;
  /** The newest sign of life: a job event (every progress call writes one), the start, or the enqueue. */
  readonly lastSignalAt: Date;
}

export interface LeaseReaperReport {
  /** Running rows past their silence threshold. */
  readonly silent: number;
  /** Failed with `jobs/stalled`. */
  readonly reaped: readonly string[];
  /** Settled with the outcome their worker produced but could not deliver. */
  readonly delivered: readonly string[];
  /** Silent, but BullMQ still holds them live (or could not be asked). */
  readonly spared: number;
}

/**
 * Settles `running` jobs that nothing will ever report on again - and `queued`
 * ones whose BullMQ attempt has already finished (2026-09-29).
 *
 * A queued row is the same failure one step earlier: the worker took the job,
 * its very first progress post (the one that flips the row to `running`) never
 * reached the API, the job failed in BullMQ, and its failure report was lost
 * the same way. Production had eleven `render.video` rows like that, queued for
 * hours while the clips behind them waited on renders nobody would ever report,
 * every one lost to a tunnel error on the way back. A queued row is only
 * settled when BullMQ has FINISHED this attempt (`completed`/`failed`): with no
 * job at all it may simply not be enqueued yet, and one still waiting will run.
 *
 * `jobs.status = 'running'` is only moved on by the worker's completion callback
 * (or a cancel). When the worker dies without calling back, the final report is
 * lost to an API restart after its retries, or Redis loses the job, the row stays
 * `running` for good: it holds one of its workspace's lane slots
 * (`admission.service.ts` counts queued + running) and its credit hold, and the
 * page behind it spins. Production had two such `media.proxy` rows for 24 days
 * (2026-09-03 to 09-27).
 *
 * **Two conditions, both required**, because each alone is wrong:
 *
 * 1. *Silent for {@link LEASE_REAPER_MISSED_BEATS} heartbeats.* The newest
 *    `job_events` row is the heartbeat: `recordProgress` appends one on every
 *    call, so no schema change is needed (the architecture panel proposed a
 *    `jobs.heartbeat_at`; the events table already answers it). But workers do
 *    not beat on a timer — a 108 s `ai.faces` pass measured 107 s between two
 *    progress calls — so silence alone would fail healthy long jobs.
 * 2. *BullMQ no longer holds the job live* ({@link LIVE_STATES}). A job a worker
 *    is still processing is `active` with a renewed lock however quiet it is,
 *    and one in backoff will be delivered again. If Redis cannot be asked, the
 *    job is spared: acting on a guess is how a healthy job gets failed.
 *
 * **A result the worker already produced is delivered, not thrown away.** When
 * worker-media's last attempt could not reach the API, the outcome stays in the
 * BullMQ job's data and the job ends `failed`; that is exactly the row this task
 * finds. So a finished job is read first, and an outcome carried for this very
 * attempt is settled as the worker would have settled it — a proxy that finished
 * stays finished, and a real refusal keeps its own code — with `jobs/stalled`
 * only when there is nothing to deliver.
 *
 * Either way it goes through `JobsService.complete` with the row's own attempt,
 * exactly as a worker's final report would: the queue owner's completion or
 * failure handler runs (a `media.proxy` marks its asset, a clip its clip, an
 * acquisition its clips run), the credit hold is settled or released, a final
 * failure is dead-lettered for an operator to replay, `job.failed` goes to
 * outgoing webhooks, the page hears it over realtime, and the conditional update
 * means a real callback racing this one simply wins.
 */
@Injectable()
export class LeaseReaperTask implements OnModuleInit {
  private readonly logger = new Logger(LeaseReaperTask.name);
  /**
   * One pass at a time in this process. The scheduler's worker runs two ticks at
   * once, and a slow pass (fifty completions, each running a failure handler)
   * must not overlap the next minute's and run the same handlers twice.
   */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly queues: QueueRegistry,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: LEASE_REAPER_TASK,
      everyMs: LEASE_REAPER_INTERVAL_MS,
      run: async ({ at }) => {
        const report = await this.tick(at);
        if (report !== null && (report.reaped.length > 0 || report.delivered.length > 0)) {
          this.logger.warn(report, "stalled jobs settled");
        }
      },
    });
  }

  /** One pass, or `null` when the previous one is still running. */
  async tick(now: Date = new Date()): Promise<LeaseReaperReport | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.sweep(now);
    } finally {
      this.running = false;
    }
  }

  /** One pass, unguarded: {@link tick} is what the schedule calls. */
  async sweep(now: Date = new Date()): Promise<LeaseReaperReport> {
    const silent = (await this.candidates()).filter((row) => isSilent(row, now));
    const reaped: string[] = [];
    const delivered: string[] = [];
    let spared = 0;

    for (const row of silent) {
      if (reaped.length + delivered.length >= LEASE_REAPER_BATCH) break;
      const queue = queueForJobType(row.type);
      const bullId = bullJobId(row.id, row.attemptId ?? row.id);
      const state = await this.bullState(queue, bullId, row.id);
      if (state === null || LIVE_STATES.has(state)) {
        spared += 1;
        continue;
      }
      // A queued row with no job in BullMQ may not have been enqueued yet: only
      // an attempt BullMQ has finished is certain never to report.
      if (row.status === "queued" && !FINISHED_STATES.has(state)) {
        spared += 1;
        continue;
      }
      const carried = FINISHED_STATES.has(state)
        ? await this.carriedOutcome(queue, bullId, row)
        : undefined;
      const settled = await this.settle(row, queue, state, carried, now);
      if (settled === "delivered") delivered.push(row.id);
      else if (settled === "reaped") reaped.push(row.id);
    }

    return { silent: silent.length, reaped, delivered, spared };
  }

  /**
   * Every in-flight (queued or running) row with its newest sign of life,
   * oldest first.
   *
   * Two typed reads rather than one raw statement, so a renamed column is a
   * compile error and the definition of a heartbeat ({@link lastSignalAt}) is
   * code a unit test covers.
   */
  private async candidates(): Promise<Candidate[]> {
    const rows = await this.prisma.job.findMany({
      where: { status: { in: ["queued", "running"] } },
      select: {
        id: true,
        type: true,
        status: true,
        attemptId: true,
        queuedAt: true,
        startedAt: true,
      },
      orderBy: { queuedAt: "asc" },
      take: LEASE_REAPER_SCAN,
    });
    const known = rows.filter(
      (row): row is typeof row & { type: QueueName; status: "queued" | "running" } =>
        isQueueName(row.type) && (row.status === "queued" || row.status === "running"),
    );
    if (known.length === 0) return [];

    const events = await this.prisma.jobEvent.groupBy({
      by: ["jobId"],
      where: { jobId: { in: known.map((row) => row.id) } },
      _max: { at: true },
    });
    const lastEvent = new Map(events.map((event) => [event.jobId, event._max.at]));

    return known
      .map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        attemptId: row.attemptId,
        lastSignalAt: lastSignalAt({ ...row, lastEventAt: lastEvent.get(row.id) ?? null }),
      }))
      .sort((a, b) => a.lastSignalAt.getTime() - b.lastSignalAt.getTime());
  }

  /** The BullMQ state of this attempt, or `null` when Redis could not say. */
  private async bullState(
    queue: QueueName,
    bullId: string,
    jobId: string,
  ): Promise<JobState | "unknown" | null> {
    try {
      return await this.queues.queue(queue).getJobState(bullId);
    } catch (error) {
      this.logger.warn(
        { jobId, queue, err: error instanceof Error ? error.message : String(error) },
        "could not read the job's queue state; not reaping it",
      );
      return null;
    }
  }

  /** The outcome this attempt's worker kept but never delivered, if it left one. */
  private async carriedOutcome(
    queue: QueueName,
    bullId: string,
    row: Candidate,
  ): Promise<CarriedOutcome | undefined> {
    try {
      const job = await this.queues.queue(queue).getJob(bullId);
      const data: unknown = job?.data;
      if (typeof data !== "object" || data === null) return undefined;
      const parsed = CarriedOutcomeSchema.safeParse(
        (data as { readonly pendingOutcome?: unknown }).pendingOutcome,
      );
      // Tied to its attempt, as the worker ties it: a replay (a new attempt)
      // must never be settled with an answer from before it.
      if (!parsed.success || parsed.data.attemptId !== (row.attemptId ?? row.id)) return undefined;
      return parsed.data;
    } catch (error) {
      this.logger.warn(
        { jobId: row.id, queue, err: error instanceof Error ? error.message : String(error) },
        "could not read the job's data; failing it as stalled",
      );
      return undefined;
    }
  }

  private async settle(
    row: Candidate,
    queue: QueueName,
    state: JobState | "unknown",
    carried: CarriedOutcome | undefined,
    now: Date,
  ): Promise<"delivered" | "reaped" | "skipped"> {
    // Re-read: the scan is a snapshot, and a callback may have settled the row,
    // or a dead-letter replay minted a new attempt, since.
    const job = await this.prisma.job.findUnique({ where: { id: row.id } });
    if (job === null || job.status !== row.status || job.attemptId !== row.attemptId) {
      return "skipped";
    }
    const attemptId = job.attemptId ?? job.id;

    const completion =
      carried !== undefined && (await this.applyCarriedPatch(job, carried))
        ? carried.completion
        : undefined;
    const body: JobCompletion = completion ?? {
      status: "failed",
      error: stalledError(queue, state, now.getTime() - row.lastSignalAt.getTime()),
      // Nothing will retry it: BullMQ has finished with (or lost) the job. Final
      // puts it in the dead-letter queue, where an operator can replay it.
      finalAttempt: true,
    };

    try {
      const ack = await this.jobs.complete(job.id, attemptId, body);
      if (!ack.applied) return "skipped";
      return completion === undefined ? "reaped" : "delivered";
    } catch (failure) {
      // The queue owner's handler threw; `complete` left the row running and the
      // next pass tries again, which is the same contract a worker gets.
      this.logger.error(
        { jobId: job.id, queue, err: failure instanceof Error ? failure.message : String(failure) },
        "could not settle a stalled job; retrying next pass",
      );
      return "skipped";
    }
  }

  /**
   * Send a carried outcome's media write-back first, as the worker does, so the
   * handler that runs on completion finds the row already right.
   *
   * Through the signed endpoint's own code (`InternalMediaController`), after the
   * same schema: a patch from Redis gets exactly the allow-list and the
   * own-prefix check a live one gets, and no second copy of either exists to
   * drift. The asset comes from the row's own params, never from Redis.
   *
   * `false` means a success cannot be delivered — its facts would be missing
   * from the row the next step reads — and the job is failed as stalled instead.
   * A failure is delivered regardless, as the worker would: the failure handler
   * marks the asset itself, and the completion is what settles the job.
   */
  private async applyCarriedPatch(
    job: { readonly id: string; readonly params: unknown },
    carried: CarriedOutcome,
  ): Promise<boolean> {
    const mediaId = mediaIdOf(job.params);
    if (carried.mediaPatch === undefined || mediaId === undefined) return true;
    const succeeded = carried.completion.status === "succeeded";
    const patch = MediaPatchDto.zodSchema.safeParse(carried.mediaPatch);
    if (!patch.success) {
      this.logger.warn({ jobId: job.id }, "a carried media write-back does not parse");
      return !succeeded;
    }
    try {
      await new InternalMediaController(this.prisma).patch(mediaId, patch.data);
      return true;
    } catch (error) {
      this.logger.warn(
        { jobId: job.id, err: error instanceof Error ? error.message : String(error) },
        "could not apply a carried media write-back",
      );
      return !succeeded;
    }
  }
}

/** The failure a job with nothing to deliver is settled with. */
function stalledError(queue: QueueName, state: JobState | "unknown", silentMs: number): JobError {
  return {
    code: JOB_STALLED_CODE,
    message: JOB_STALLED_MESSAGE,
    retryable: true,
    facts: { silentMs, heartbeatMs: heartbeatIntervalMs(queue), queueState: state },
  };
}

function mediaIdOf(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const mediaId = (params as { readonly mediaId?: unknown }).mediaId;
  return typeof mediaId === "string" && mediaId !== "" ? mediaId : undefined;
}

/**
 * A running job's newest sign of life: its latest event, else when it started,
 * else when it was queued — whichever is latest. An event older than the start
 * belongs to an earlier attempt (a dead-letter replay keeps the job's events)
 * and must not make a fresh attempt look long dead.
 */
export function lastSignalAt(row: {
  readonly queuedAt: Date;
  readonly startedAt: Date | null;
  readonly lastEventAt: Date | null;
}): Date {
  const started = row.startedAt ?? row.queuedAt;
  const event = row.lastEventAt ?? row.queuedAt;
  return event.getTime() > started.getTime() ? event : started;
}

/** Silent for longer than {@link LEASE_REAPER_MISSED_BEATS} of its queue's heartbeats. */
export function isSilent(
  row: { readonly type: string; readonly lastSignalAt: Date },
  now: Date,
): boolean {
  if (!isQueueName(row.type)) return false;
  const limit = LEASE_REAPER_MISSED_BEATS * heartbeatIntervalMs(queueForJobType(row.type));
  return now.getTime() - row.lastSignalAt.getTime() > limit;
}
