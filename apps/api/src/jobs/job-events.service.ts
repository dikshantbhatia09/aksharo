import { Injectable, Logger } from "@nestjs/common";

import { jobUlid } from "./ids.js";
import { JOB_EVENT_RETENTION_DAYS } from "./jobs.config.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

import type { LogLevel, Prisma } from "@prisma/client";

/** The lifecycle points a job records. `job.*` so a log search finds them all. */
export const JOB_EVENT_NAMES = [
  "job.queued",
  "job.started",
  "job.progress",
  "job.succeeded",
  "job.failed",
  "job.cancelled",
  "job.timed_out",
  "job.child_enqueued",
  "job.dead_lettered",
  /** An admin sent a dead letter back to its queue with a fresh attempt (A08b). */
  "job.replayed",
  /** An admin gave up on a dead letter and released its hold (A08b). */
  "job.dlq_discarded",
  /** The job type's completion handler threw; the job stays open for a retry (A07). */
  "job.completion_handler_failed",
] as const;

export type JobEventName = (typeof JOB_EVENT_NAMES)[number];

export interface AppendJobEvent {
  readonly jobId: string;
  readonly name: JobEventName;
  readonly message?: string;
  readonly level?: LogLevel;
  readonly data?: Record<string, unknown>;
}

/**
 * Appends to `job_events`, the per-job audit trail behind `GET /jobs/{id}/events`.
 *
 * Every row carries a **retention marker** — `data.retainUntil`, 30 days out
 * (D47) — rather than relying on a sweeper knowing the rule: the row states its own
 * expiry, so the daily purge (B16) is a single `WHERE` and a change to the policy
 * does not rewrite history.
 *
 * Appending never throws. An audit row that fails to write must not fail the job
 * transition it was describing; the failure is logged and the job moves on.
 */
@Injectable()
export class JobEventsService {
  private readonly logger = new Logger(JobEventsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async append(event: AppendJobEvent): Promise<void> {
    try {
      await this.prisma.jobEvent.create({ data: this.row(event) });
    } catch (error) {
      this.logger.warn(
        { jobId: event.jobId, name: event.name, err: describe(error) },
        "job event not recorded",
      );
    }
  }

  /** The row shape, so a caller inside a transaction can write it with `tx`. */
  row(event: AppendJobEvent): Prisma.JobEventUncheckedCreateInput {
    const retainUntil = new Date(Date.now() + JOB_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    return {
      id: jobUlid(),
      jobId: event.jobId,
      level: event.level ?? "info",
      message: event.message ?? event.name,
      data: {
        event: event.name,
        retainUntil: retainUntil.toISOString(),
        retentionDays: JOB_EVENT_RETENTION_DAYS,
        ...(event.data ?? {}),
      } satisfies Prisma.InputJsonValue,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
