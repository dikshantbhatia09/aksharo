import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { buildJobEnvelope } from "./contracts/job-envelope.js";
import { isQueueName, queueForJobType } from "./contracts/queue-names.js";
import { jobUlid } from "./ids.js";
import { JobEventsService } from "./job-events.service.js";
import { DLQ_MAX_BULK, JOBS_MAX_PAGE_SIZE, JOBS_PAGE_SIZE } from "./jobs.config.js";
import { JOB_ERROR_CODES } from "./jobs.errors.js";
import { QueueRegistry } from "./queue.registry.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { MetricsService } from "../common/metrics/metrics.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";
import { CREDITS_FACADE } from "../credits/credits.facade.js";
import { RealtimePublisher } from "../realtime/realtime.publisher.js";

import type { JobCompletion } from "./contracts/completion.js";
import type { CreditsFacade } from "../credits/credits.facade.js";
import type { DlqEntry, DlqStatus, Job } from "@prisma/client";

/** Who asked. Every replay and every discard is attributable (THREAT-MODEL T20). */
export interface AdminActor {
  readonly userId: string;
  readonly ip?: string | undefined;
}

export interface ListDlqInput {
  readonly queue?: string;
  readonly status?: DlqStatus;
  readonly workspaceId?: string;
  /** Substring of the last error's `code` or `message`, case-insensitive. */
  readonly reason?: string;
  readonly since?: Date;
  readonly until?: Date;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface DlqPage {
  readonly items: readonly DlqEntry[];
  readonly nextCursor: string | null;
}

/** Per-queue summary: the three numbers the runbook asks for before touching anything. */
export interface DlqQueueStats {
  readonly queue: string;
  readonly pending: number;
  readonly replayed: number;
  readonly discarded: number;
  readonly oldestFailedAt: string | null;
  readonly newestFailedAt: string | null;
  /** How many distinct error codes are represented among the pending rows. */
  readonly distinctErrors: number;
}

export interface ReplayResult {
  readonly entryId: string;
  readonly jobId: string;
  /** The attempt ULID minted for the replay. */
  readonly attemptId: string;
  /** 1-based ordinal of that attempt: three failures then a replay is 4. */
  readonly attemptNo: number;
  readonly queue: string;
}

export interface DiscardResult {
  readonly entryId: string;
  readonly jobId: string;
  readonly queue: string;
  readonly reason: string;
  /** True when a credit hold was actually released (a settled job has none). */
  readonly holdReleased: boolean;
}

export interface BulkOutcome {
  /** Rows the filter selected. */
  readonly selected: number;
  readonly replayed: number;
  readonly discarded: number;
  readonly failed: number;
  /** Nothing was changed; the counts are what *would* have happened. */
  readonly dryRun: boolean;
  readonly entries: readonly {
    readonly entryId: string;
    readonly jobId: string;
    readonly queue: string;
    readonly outcome: "replayed" | "discarded" | "would_replay" | "would_discard" | "failed";
    readonly error?: string;
  }[];
}

/**
 * The dead-letter queue: what happens after the last attempt fails, and the two
 * things an admin can do about it.
 *
 * **Why a table and not just Redis.** BullMQ keeps failed jobs for a week
 * (`removeOnFail` in `QueueRegistry`) and then forgets them, keyed by a Redis id
 * that means nothing to the rest of the system. A dead letter has to outlive that:
 * it is the record of work a workspace paid for and did not get, it has to be
 * searchable by queue and by error, and the decision an operator makes about it —
 * replay or discard, and why — is itself worth keeping. Hence `dlq`, written from
 * the completion path and never purged by the retention sweep.
 *
 * **Replay semantics** (the whole reason this class exists):
 *
 * 1. The dead letter is *claimed* first, with a conditional update that only a
 *    `pending` row can satisfy. Two admins clicking replay at the same moment, or
 *    a runbook script retried after a timeout, means exactly one replay.
 * 2. The **same `jobs` row** is reused. The job id a client is polling does not
 *    change, `jobKey` is preserved, and the live-key uniqueness index still holds
 *    because there is still only one live job for that key.
 * 3. A **fresh `attemptId`** (ULID) is minted and `attemptNo` is incremented, so
 *    the BullMQ job id `{jobId}-{attemptId}` is new and the completion callback of
 *    the *old* attempt — a worker that finally came back — is rejected as
 *    `stale_attempt` by the idempotency check that was already there (T8).
 * 4. Credits are **reserved again** through the facade (CONTRACTS §4), for the
 *    amount the original attempt held, which the dead-letter row recorded before
 *    the completion path zeroed the column. A replay that skipped this would
 *    produce work nobody paid for.
 * 5. The BullMQ job is added **last**, exactly as in `JobsService.enqueue`, so a
 *    failure at any earlier step unwinds with nothing enqueued.
 *
 * Nothing is re-signed: workers sign their own callbacks with
 * `INTERNAL_CALLBACK_SECRET` and the API only ever verifies.
 */
@Injectable()
export class DlqService {
  private readonly logger = new Logger(DlqService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly events: JobEventsService,
    private readonly metrics: MetricsService,
    private readonly realtime: RealtimePublisher,
    @Inject(CREDITS_FACADE) private readonly credits: CreditsFacade,
  ) {}

  // -------------------------------------------------------------------------
  // Writing: the completion path calls this
  // -------------------------------------------------------------------------

  /**
   * Record a job whose final attempt failed.
   *
   * Called from `JobsService.complete` with the job row **as it was before** the
   * completion update, because that row still carries the credit hold this entry
   * has to remember for a later replay.
   *
   * Idempotent on `(jobId, attemptId)`: an at-least-once completion callback that
   * arrives twice produces one row, and the second call returns the first one.
   */
  async record(job: Job, body: JobCompletion): Promise<DlqEntry> {
    const attemptId = job.attemptId ?? job.id;
    const reason = body.error?.code ?? ERROR_CODES.internal;

    const entry = await this.prisma.dlqEntry.upsert({
      where: { jobId_attemptId: { jobId: job.id, attemptId } },
      // A replayed callback must not resurrect a resolved row or rewrite history.
      update: {},
      create: {
        id: jobUlid(),
        jobId: job.id,
        workspaceId: job.workspaceId,
        projectId: job.projectId,
        queue: job.type,
        jobKey: job.jobKey,
        attemptId,
        attemptNo: job.attemptNo,
        attempts: job.attemptNo,
        payload: (job.params ?? {}) as Prisma.InputJsonValue,
        ...(body.error === undefined
          ? {}
          : { lastError: body.error as unknown as Prisma.InputJsonValue }),
        // The hold, captured before `complete` overwrote the column with the
        // settled amount. A replay reserves this much again.
        worstCaseTenths: job.creditsChargedTenths,
        failedAt: new Date(),
        status: "pending",
      },
    });

    await this.prisma.job.update({
      where: { id: job.id },
      data: { dlq: true, dlqReason: reason, dlqAt: entry.failedAt },
    });

    await this.events.append({
      jobId: job.id,
      name: "job.dead_lettered",
      level: "error",
      message: "no attempts left",
      data: {
        dlq: true,
        dlqEntryId: entry.id,
        queue: job.type,
        attemptId,
        attemptNo: job.attemptNo,
        ...(body.error === undefined ? {} : { lastError: body.error }),
      },
    });

    await this.refreshDepth(job.type);
    this.logger.error(
      { jobId: job.id, queue: job.type, attemptNo: job.attemptNo, reason },
      "job dead-lettered",
    );
    return entry;
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(input: ListDlqInput): Promise<DlqPage> {
    const take = clampLimit(input.limit);
    const items = await this.prisma.dlqEntry.findMany({
      where: this.whereFor(input),
      // Ids are ULIDs minted at dead-letter time, so the id alone is a stable,
      // time-ordered cursor — no (timestamp, id) tuple and no ties to break.
      orderBy: { id: "desc" },
      ...(input.cursor === undefined ? {} : { cursor: { id: input.cursor }, skip: 1 }),
      take: take + 1,
    });
    if (items.length <= take) return { items, nextCursor: null };
    const page = items.slice(0, take);
    return { items: page, nextCursor: page[page.length - 1]?.id ?? null };
  }

  /** @throws AppException 404 when neither an entry id nor a job id matches. */
  async get(id: string): Promise<DlqEntry> {
    const entry = await this.findByEitherId(id);
    if (entry === null) {
      throw new AppException(
        JOB_ERROR_CODES.dlqNotFound,
        "No such dead-letter entry.",
        HttpStatus.NOT_FOUND,
        { id },
      );
    }
    return entry;
  }

  /**
   * Per-queue counts, the oldest and newest failure, and how many distinct error
   * codes are pending — the three numbers `docs/runbooks/dlq-replay.md` §1 asks
   * for before anyone touches anything.
   */
  async stats(): Promise<readonly DlqQueueStats[]> {
    const rows = await this.prisma.$queryRaw<
      {
        queue: string;
        pending: bigint;
        replayed: bigint;
        discarded: bigint;
        oldest: Date | null;
        newest: Date | null;
        distinct_errors: bigint;
      }[]
    >`
      SELECT queue,
             COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
             COUNT(*) FILTER (WHERE status = 'replayed')   AS replayed,
             COUNT(*) FILTER (WHERE status = 'discarded')  AS discarded,
             MIN(failed_at) FILTER (WHERE status = 'pending') AS oldest,
             MAX(failed_at) FILTER (WHERE status = 'pending') AS newest,
             COUNT(DISTINCT last_error ->> 'code') FILTER (WHERE status = 'pending')
               AS distinct_errors
      FROM dlq
      GROUP BY queue
      ORDER BY queue ASC
    `;
    return rows.map((row) => ({
      queue: row.queue,
      pending: Number(row.pending),
      replayed: Number(row.replayed),
      discarded: Number(row.discarded),
      oldestFailedAt: row.oldest?.toISOString() ?? null,
      newestFailedAt: row.newest?.toISOString() ?? null,
      distinctErrors: Number(row.distinct_errors),
    }));
  }

  /**
   * Re-publish `montaj_queue_dlq_depth` for every queue that has ever had a dead
   * letter. Called after every write, and by the scheduled sampler.
   */
  async refreshDepth(queue?: string): Promise<void> {
    try {
      const grouped = await this.prisma.dlqEntry.groupBy({
        by: ["queue"],
        where: { status: "pending" },
        _count: { _all: true },
      });
      const depths = new Map(grouped.map((row) => [row.queue, row._count._all]));
      // A queue that has drained to zero must still report zero: a series that
      // disappears is indistinguishable from a healthy one that was never scraped.
      const queues = new Set<string>([...depths.keys(), ...(queue === undefined ? [] : [queue])]);
      for (const name of queues) this.metrics.dlqDepth(name, depths.get(name) ?? 0);
    } catch (error) {
      this.logger.warn({ err: describe(error) }, "dlq depth gauge not refreshed");
    }
  }

  // -------------------------------------------------------------------------
  // Acting
  // -------------------------------------------------------------------------

  /** Send one dead letter back to its queue with a fresh attempt. */
  async replay(id: string, actor: AdminActor): Promise<ReplayResult> {
    const entry = await this.get(id);
    const claimed = await this.claim(entry, actor, "replayed");

    const job = await this.prisma.job.findUnique({ where: { id: claimed.jobId } });
    if (job === null) {
      await this.unclaim(claimed.id);
      throw new AppException(
        JOB_ERROR_CODES.notFound,
        "The dead-lettered job no longer exists.",
        HttpStatus.NOT_FOUND,
        { jobId: claimed.jobId },
      );
    }
    if (job.status !== "failed") {
      // Somebody already retried it, or a late callback succeeded. Either way the
      // dead letter is stale and a replay would create a second live job for the
      // same `jobKey`.
      await this.unclaim(claimed.id);
      throw new AppException(
        JOB_ERROR_CODES.dlqJobNotFailed,
        `The job is ${job.status}, not failed; there is nothing to replay.`,
        HttpStatus.CONFLICT,
        { jobId: job.id, status: job.status },
      );
    }
    if (!isQueueName(job.type)) {
      await this.unclaim(claimed.id);
      throw new AppException(
        JOB_ERROR_CODES.invalidType,
        `"${job.type}" is not a queue in CONTRACTS section 3.`,
        HttpStatus.CONFLICT,
        { jobId: job.id, type: job.type },
      );
    }

    const attemptId = jobUlid();
    const attemptNo = job.attemptNo + 1;
    const worstCaseTenths = claimed.worstCaseTenths;

    let holdId: string;
    try {
      holdId = (
        await this.credits.reserve({
          workspaceId: job.workspaceId,
          jobId: job.id,
          worstCaseTenths,
          reason: `replay of ${job.type} attempt ${String(attemptNo)}`,
        })
      ).holdId;
    } catch (error) {
      await this.unclaim(claimed.id);
      throw error;
    }

    const queuedAt = new Date();
    await this.prisma.job.update({
      where: { id: job.id },
      data: {
        status: "queued",
        attemptId,
        attemptNo,
        progress: 0,
        etaMs: null,
        startedAt: null,
        finishedAt: null,
        // `DbNull`, not `null`: on a nullable JSONB column Prisma reads a bare
        // `null` as the JSON value `null`, which is not the same as no error.
        error: Prisma.DbNull,
        creditHoldId: holdId,
        creditsChargedTenths: worstCaseTenths,
        // The row is live again, so the marker comes off. The `dlq` row keeps the
        // history — that is what it is for.
        dlq: false,
        dlqReason: null,
        dlqAt: null,
        queuedAt,
      },
    });

    const envelope = buildJobEnvelope({
      jobId: job.id,
      attemptId,
      workspaceId: job.workspaceId,
      projectId: job.projectId,
      priority: job.priority,
      jobKey: job.jobKey,
      createdAt: queuedAt,
      payload: (claimed.payload ?? {}) as Record<string, unknown>,
    });

    try {
      await this.queues.queue(queueForJobType(job.type)).add(
        job.type,
        envelope,
        this.queues.optionsFor({
          queueName: job.type,
          jobId: job.id,
          attemptId,
          priority: job.priority,
        }),
      );
    } catch (error) {
      await this.credits.release({ holdId });
      await this.prisma.job.update({
        where: { id: job.id },
        data: {
          status: "failed",
          attemptId: job.attemptId,
          attemptNo: job.attemptNo,
          finishedAt: new Date(),
          creditsChargedTenths: 0,
          creditHoldId: job.creditHoldId,
          dlq: true,
          dlqReason: job.dlqReason,
          dlqAt: job.dlqAt,
          error: { code: ERROR_CODES.unavailable, message: "Queue unavailable.", retryable: true },
        },
      });
      await this.unclaim(claimed.id);
      throw new AppException(
        ERROR_CODES.unavailable,
        "The job queue is unavailable; please retry the replay.",
        HttpStatus.SERVICE_UNAVAILABLE,
        { jobId: job.id, cause: describe(error) },
      );
    }

    await this.prisma.dlqEntry.update({
      where: { id: claimed.id },
      data: { resolution: `replayed as attempt ${String(attemptNo)} (${attemptId})` },
    });
    await this.events.append({
      jobId: job.id,
      name: "job.replayed",
      level: "warn",
      message: `replayed as attempt ${String(attemptNo)}`,
      data: {
        dlqEntryId: claimed.id,
        attemptId,
        attemptNo,
        holdId,
        worstCaseTenths,
        actor: actor.userId,
      },
    });
    await this.audit(actor, "dlq.replay", claimed, {
      attemptId,
      attemptNo,
      worstCaseTenths,
    });
    await this.realtime.jobProgress(job, { jobId: job.id, progress: 0, message: "Retrying." });

    this.metrics.dlqResolved(job.type, "replayed");
    await this.refreshDepth(job.type);

    return { entryId: claimed.id, jobId: job.id, attemptId, attemptNo, queue: job.type };
  }

  /**
   * Give up on a dead letter: release its credit hold and record why.
   *
   * The reason is mandatory. "Discarding records a reason. Never discard silently —
   * the DLQ is also the record of what the system could not do."
   */
  async discard(id: string, reason: string, actor: AdminActor): Promise<DiscardResult> {
    const trimmed = reason.trim();
    if (trimmed === "") {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "A discard needs a reason.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const entry = await this.get(id);
    const claimed = await this.claim(entry, actor, "discarded", trimmed);

    const job = await this.prisma.job.findUnique({ where: { id: claimed.jobId } });
    let holdReleased = false;
    if (job !== null && job.creditHoldId !== null) {
      // Idempotent in the facade, so a hold the failure path already released is
      // not released twice (CONTRACTS section 4).
      await this.credits.release({ holdId: job.creditHoldId });
      holdReleased = true;
      await this.prisma.job.update({
        where: { id: job.id },
        data: { creditHoldId: null, creditsChargedTenths: 0 },
      });
    }

    await this.events.append({
      jobId: claimed.jobId,
      name: "job.dlq_discarded",
      level: "warn",
      message: trimmed,
      data: { dlqEntryId: claimed.id, holdReleased, actor: actor.userId },
    });
    await this.audit(actor, "dlq.discard", claimed, { reason: trimmed, holdReleased });

    this.metrics.dlqResolved(claimed.queue, "discarded");
    await this.refreshDepth(claimed.queue);

    return {
      entryId: claimed.id,
      jobId: claimed.jobId,
      queue: claimed.queue,
      reason: trimmed,
      holdReleased,
    };
  }

  /**
   * Replay or discard everything a filter selects, one at a time.
   *
   * Sequential on purpose: a bulk replay competes with live user traffic for the
   * same workers, and the runbook tells an operator to do it in small batches and
   * watch the first one land. `dryRun` selects and reports without touching
   * anything, which is what makes `--dry-run` in the runbook script honest.
   *
   * One entry failing does not stop the rest — a bulk operation that aborts halfway
   * leaves an operator with no idea what happened — so failures are counted and
   * listed.
   */
  async bulk(
    input: ListDlqInput & {
      readonly ids?: readonly string[];
      readonly action: "replay" | "discard";
      /**
       * Recorded on every row a discard resolves. Deliberately NOT
       * {@link ListDlqInput.reason}, which is the error-text *filter*: conflating
       * the two makes `discard --queue=x --reason="bad input"` silently select
       * only the entries whose error happens to contain the words "bad input".
       */
      readonly discardReason?: string;
      readonly dryRun?: boolean;
    },
    actor: AdminActor,
  ): Promise<BulkOutcome> {
    const dryRun = input.dryRun ?? false;
    if (input.action === "discard" && (input.discardReason ?? "").trim() === "") {
      throw new AppException(
        ERROR_CODES.validationFailed,
        "A bulk discard needs a reason.",
        HttpStatus.BAD_REQUEST,
      );
    }

    const limit = Math.min(DLQ_MAX_BULK, Math.max(1, Math.floor(input.limit ?? DLQ_MAX_BULK)));
    const selected =
      input.ids === undefined || input.ids.length === 0
        ? await this.prisma.dlqEntry.findMany({
            where: { ...this.whereFor({ ...input, limit: undefined }), status: "pending" },
            orderBy: { id: "asc" },
            take: limit,
          })
        : await this.prisma.dlqEntry.findMany({
            where: { OR: [{ id: { in: [...input.ids] } }, { jobId: { in: [...input.ids] } }] },
            orderBy: { id: "asc" },
            take: limit,
          });

    const entries: BulkOutcome["entries"][number][] = [];
    let replayed = 0;
    let discarded = 0;
    let failed = 0;

    for (const entry of selected) {
      if (dryRun) {
        entries.push({
          entryId: entry.id,
          jobId: entry.jobId,
          queue: entry.queue,
          outcome: input.action === "replay" ? "would_replay" : "would_discard",
        });
        continue;
      }
      try {
        if (input.action === "replay") {
          await this.replay(entry.id, actor);
          replayed += 1;
          entries.push({
            entryId: entry.id,
            jobId: entry.jobId,
            queue: entry.queue,
            outcome: "replayed",
          });
        } else {
          await this.discard(entry.id, input.discardReason ?? "", actor);
          discarded += 1;
          entries.push({
            entryId: entry.id,
            jobId: entry.jobId,
            queue: entry.queue,
            outcome: "discarded",
          });
        }
      } catch (error) {
        failed += 1;
        entries.push({
          entryId: entry.id,
          jobId: entry.jobId,
          queue: entry.queue,
          outcome: "failed",
          error: describe(error),
        });
      }
    }

    return { selected: selected.length, replayed, discarded, failed, dryRun, entries };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** An entry id or the job id of its newest pending entry — the runbook uses both. */
  private async findByEitherId(id: string): Promise<DlqEntry | null> {
    const byId = await this.prisma.dlqEntry.findUnique({ where: { id } });
    if (byId !== null) return byId;
    return this.prisma.dlqEntry.findFirst({
      where: { jobId: id },
      // Pending first, then newest: a job that dead-lettered twice has one row an
      // operator can still act on and one that is already history.
      orderBy: [{ status: "asc" }, { id: "desc" }],
    });
  }

  /**
   * Take the row out of `pending` before doing anything irreversible.
   *
   * The conditional `updateMany` is the concurrency control for the whole class:
   * two admins, or a runbook script retried after a timeout, and exactly one wins.
   *
   * @throws AppException 409 when the row was already replayed or discarded.
   */
  private async claim(
    entry: DlqEntry,
    actor: AdminActor,
    status: Extract<DlqStatus, "replayed" | "discarded">,
    resolution?: string,
  ): Promise<DlqEntry> {
    const { count } = await this.prisma.dlqEntry.updateMany({
      where: { id: entry.id, status: "pending" },
      data: {
        status,
        resolvedBy: actor.userId,
        resolvedAt: new Date(),
        ...(resolution === undefined ? {} : { resolution }),
      },
    });
    if (count === 0) {
      const current = await this.prisma.dlqEntry.findUnique({ where: { id: entry.id } });
      throw new AppException(
        JOB_ERROR_CODES.dlqAlreadyResolved,
        `This dead letter was already ${current?.status ?? "resolved"}.`,
        HttpStatus.CONFLICT,
        { entryId: entry.id, status: current?.status ?? null },
      );
    }
    return { ...entry, status, resolvedBy: actor.userId, resolvedAt: new Date() };
  }

  /** Put a claimed row back, because the work after the claim did not happen. */
  private async unclaim(entryId: string): Promise<void> {
    await this.prisma.dlqEntry
      .update({
        where: { id: entryId },
        data: { status: "pending", resolvedBy: null, resolvedAt: null, resolution: null },
      })
      .catch((error: unknown) => {
        this.logger.error({ entryId, err: describe(error) }, "dlq entry left claimed");
      });
  }

  private whereFor(input: ListDlqInput): Prisma.DlqEntryWhereInput {
    const failedAt: Prisma.DateTimeFilter = {};
    if (input.since !== undefined) failedAt.gte = input.since;
    if (input.until !== undefined) failedAt.lte = input.until;

    return {
      ...(input.queue === undefined ? {} : { queue: input.queue }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
      ...(Object.keys(failedAt).length === 0 ? {} : { failedAt }),
      ...(input.reason === undefined || input.reason === ""
        ? {}
        : {
            // `last_error` is JSONB; Prisma's string filters do not reach inside
            // it, so the match is on the serialised value through `string_contains`
            // on the two fields that carry text.
            OR: [
              { lastError: { path: ["code"], string_contains: input.reason } },
              { lastError: { path: ["message"], string_contains: input.reason } },
            ],
          }),
    };
  }

  /** Every admin action on the DLQ lands in `audit_log` (THREAT-MODEL T20). */
  private async audit(
    actor: AdminActor,
    action: string,
    entry: DlqEntry,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          id: jobUlid(),
          workspaceId: entry.workspaceId,
          actorId: actor.userId,
          actorKind: "admin",
          action,
          resource: "dlq",
          resourceId: entry.id,
          data: { jobId: entry.jobId, queue: entry.queue, ...data } as Prisma.InputJsonValue,
          ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        },
      });
    } catch (error) {
      // An audit row that fails to write must not undo a replay that succeeded,
      // but it must be loud: this is the T20 trail.
      this.logger.error(
        { action, entryId: entry.id, err: describe(error) },
        "admin action not audited",
      );
    }
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return JOBS_PAGE_SIZE;
  return Math.min(JOBS_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
