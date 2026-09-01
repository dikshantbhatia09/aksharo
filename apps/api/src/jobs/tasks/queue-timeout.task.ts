import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { QUEUE_TIMEOUT_BATCH, QUEUE_TIMEOUT_INTERVAL_MS } from "../jobs.config.js";
import { JobsService } from "../jobs.service.js";

/** The scheduled task's name; also its BullMQ scheduler key. */
export const QUEUE_TIMEOUT_TASK = "jobs.queue-timeout";

/**
 * Fails jobs that have waited longer than their plan's `maxQueueWaitMs` and gives
 * the credits back (THREAT-MODEL T23).
 *
 * A job with no worker is worse than a failed one: it holds credits the workspace
 * cannot spend and shows a spinner that never resolves. Half a minute of latency
 * on the sweep is fine — the timeouts are minutes — so the task runs every
 * {@link QUEUE_TIMEOUT_INTERVAL_MS} and takes at most {@link QUEUE_TIMEOUT_BATCH}
 * rows a pass, so a backlog drains over several ticks instead of holding one long
 * transaction.
 *
 * The candidate query does the arithmetic in SQL (`queued_at + max_queue_wait_ms`)
 * because Prisma cannot compare a column against another column plus a literal.
 * `jobs (workspace_id, status, queued_at)` is indexed, and the predicate is
 * restricted to `status = 'queued'`.
 */
@Injectable()
export class QueueTimeoutTask implements OnModuleInit {
  private readonly logger = new Logger(QueueTimeoutTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: QUEUE_TIMEOUT_TASK,
      everyMs: QUEUE_TIMEOUT_INTERVAL_MS,
      run: async () => {
        await this.sweep();
      },
    });
  }

  /** One pass. Returns how many jobs were failed. */
  async sweep(now: Date = new Date()): Promise<number> {
    const candidates = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM jobs
      WHERE status = 'queued'
        AND max_queue_wait_ms IS NOT NULL
        AND queued_at + (max_queue_wait_ms * INTERVAL '1 millisecond') < ${now}
      ORDER BY queued_at ASC
      LIMIT ${QUEUE_TIMEOUT_BATCH}
    `;
    if (candidates.length === 0) return 0;

    let failed = 0;
    for (const { id } of candidates) {
      const job = await this.prisma.job.findUnique({ where: { id } });
      // Re-read rather than trusting the scan: a worker may have picked the job up
      // between the query and here, and `timeOut` will refuse it.
      if (job === null) continue;
      if (await this.jobs.timeOut(job)) failed += 1;
    }

    if (failed > 0) {
      this.logger.warn({ failed, scanned: candidates.length }, "jobs failed on queue timeout");
    }
    return failed;
  }
}
