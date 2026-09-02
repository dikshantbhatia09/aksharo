import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const ACCESS_LOG_PURGE_TASK = "scheduler.access-log-purge";

/** Daily (06-data-model.md §Retention jobs: "access-log purge after 1 year"). */
const ACCESS_LOG_PURGE_CRON = "40 2 * * *";
const RETENTION_DAYS = 365;
const BATCH = 5_000;
const MAX_BATCHES = 40;

/**
 * `access_logs` is retained "at least a year" (D61 Rule 6, `AccessLog`'s own
 * schema comment) and purged after — this is the after. Deleted in bounded
 * batches, same reasoning as `JobEventRetentionTask`: a year of access-log rows
 * on a busy workspace is a lot of rows, and one unbounded `DELETE` would hold
 * its locks for as long as it takes.
 */
@Injectable()
export class AccessLogPurgeTask implements OnModuleInit {
  private readonly logger = new Logger(AccessLogPurgeTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: ACCESS_LOG_PURGE_TASK,
      cron: ACCESS_LOG_PURGE_CRON,
      run: async ({ at }) => {
        const deleted = await this.sweep(at);
        if (deleted > 0)
          this.logger.log({ deleted, retentionDays: RETENTION_DAYS }, "access logs purged");
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM access_logs
        WHERE ctid IN (SELECT ctid FROM access_logs WHERE at < ${before} LIMIT ${BATCH})
      `;
      deleted += removed;
      if (removed < BATCH) break;
    }
    return deleted;
  }
}
