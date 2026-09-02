import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const CRASH_REPORT_RETENTION_TASK = "scheduler.crash-report-retention";

/** Daily (C12 brief §1: "30-day retention via a B16 scheduler task"). */
const CRASH_REPORT_RETENTION_CRON = "45 2 * * *";
const RETENTION_DAYS = 30;
const BATCH = 5_000;
const MAX_BATCHES = 40;

/**
 * `crash_reports` (C12) is kept 30 days — long enough to triage a bad release,
 * short enough that a redacted stack trace and log tail do not become an
 * indefinite record. Purged in bounded batches, the same pattern as
 * `AccessLogPurgeTask`: an unbounded `DELETE` over a busy table holds its
 * locks for as long as it takes.
 */
@Injectable()
export class CrashReportRetentionTask implements OnModuleInit {
  private readonly logger = new Logger(CrashReportRetentionTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: CRASH_REPORT_RETENTION_TASK,
      cron: CRASH_REPORT_RETENTION_CRON,
      run: async ({ at }) => {
        const deleted = await this.sweep(at);
        if (deleted > 0)
          this.logger.log({ deleted, retentionDays: RETENTION_DAYS }, "crash reports purged");
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<number> {
    const before = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM crash_reports
        WHERE ctid IN (SELECT ctid FROM crash_reports WHERE created_at < ${before} LIMIT ${BATCH})
      `;
      deleted += removed;
      if (removed < BATCH) break;
    }
    return deleted;
  }
}
