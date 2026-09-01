import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import {
  JOB_EVENT_RETENTION_BATCH,
  JOB_EVENT_RETENTION_CRON,
  JOB_EVENT_RETENTION_DAYS,
  JOB_EVENT_RETENTION_MAX_BATCHES,
} from "../jobs.config.js";

/** The scheduled task's name; also its BullMQ scheduler key. */
export const JOB_EVENT_RETENTION_TASK = "jobs.event-retention";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes `job_events` rows past their retention date (D47, 30 days).
 *
 * **Every row states its own expiry.** `JobEventsService` writes
 * `data.retainUntil` on creation, so the sweep is a single `WHERE` and a later
 * change to the policy does not retroactively rewrite — or retroactively delete —
 * history. Rows written before that marker existed, and any row whose marker is
 * malformed, fall back to `at < now() - 30 days`, which is the same rule applied
 * to the only other date the row has.
 *
 * **It deletes in batches.** A month of events on a busy instance is millions of
 * rows, and one unbounded `DELETE` holds a transaction, and the locks under it,
 * for as long as it takes. The sweep loops on
 * {@link JOB_EVENT_RETENTION_BATCH} and stops as soon as a pass deletes fewer than
 * a full batch, with {@link JOB_EVENT_RETENTION_MAX_BATCHES} as the ceiling so one
 * pathological night cannot run into the morning.
 *
 * **Dead letters are not touched.** `dlq` rows are the record of what the system
 * could not do and are kept for good; only the chatty per-attempt log expires.
 */
@Injectable()
export class JobEventRetentionTask implements OnModuleInit {
  private readonly logger = new Logger(JobEventRetentionTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: JOB_EVENT_RETENTION_TASK,
      cron: JOB_EVENT_RETENTION_CRON,
      run: async () => {
        await this.sweep();
      },
    });
  }

  /** One pass. Returns how many rows were deleted. */
  async sweep(now: Date = new Date()): Promise<number> {
    const fallbackBefore = new Date(now.getTime() - JOB_EVENT_RETENTION_DAYS * DAY_MS);
    let deleted = 0;

    for (let batch = 0; batch < JOB_EVENT_RETENTION_MAX_BATCHES; batch += 1) {
      // `ctid` rather than a join on `id`: it is the cheapest possible way to
      // delete exactly the rows the sub-select found, and the sub-select is the
      // only place the retention rule is expressed.
      const removed = await this.prisma.$executeRaw`
        DELETE FROM job_events
        WHERE ctid IN (
          SELECT ctid FROM job_events
          WHERE
            CASE
              WHEN data ? 'retainUntil'
                THEN (data ->> 'retainUntil') < ${now.toISOString()}
              ELSE at < ${fallbackBefore}
            END
          LIMIT ${JOB_EVENT_RETENTION_BATCH}
        )
      `;
      deleted += removed;
      if (removed < JOB_EVENT_RETENTION_BATCH) break;
    }

    if (deleted > 0) {
      this.logger.log(
        { deleted, retentionDays: JOB_EVENT_RETENTION_DAYS },
        "expired job events deleted",
      );
    }
    return deleted;
  }
}
