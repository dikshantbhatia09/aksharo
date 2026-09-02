import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const USAGE_REPORT_TASK = "scheduler.usage-report";

/** Monthly, 3rd of the month (06-data-model.md §Retention jobs: "usage/asset-usage reports (stub)"). */
const USAGE_REPORT_CRON = "0 5 3 * *";

export interface UsageReport {
  readonly period: string;
  readonly jobsCompleted: number;
  readonly assetUsageRows: number;
}

/**
 * The usage and asset-usage report the brief names explicitly as a **stub**:
 * a real per-workspace usage digest (which features, how much media, licence
 * exposure from `asset_usages`) is product-facing work for a later work
 * package's dashboard, not a count this scheduler primitive should own the
 * shape of. What is real here is the count this task computes and logs —
 * `jobs` completed and `asset_usages` rows written in the month that ended —
 * so the schedule exists, is registered, and is idempotent (re-running for an
 * already-reported month recomputes the same counts from immutable rows,
 * rather than mutating anything) ahead of that later work package giving it a
 * destination.
 */
@Injectable()
export class UsageReportTask implements OnModuleInit {
  private readonly logger = new Logger(UsageReportTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: USAGE_REPORT_TASK,
      cron: USAGE_REPORT_CRON,
      run: async ({ at }) => {
        const report = await this.run(previousMonthRange(at));
        this.logger.log(report, "usage report generated (stub)");
      },
    });
  }

  async run(range: {
    readonly period: string;
    readonly gte: Date;
    readonly lt: Date;
  }): Promise<UsageReport> {
    const [jobsCompleted, assetUsageRows] = await Promise.all([
      this.prisma.job.count({
        where: { status: "succeeded", finishedAt: { gte: range.gte, lt: range.lt } },
      }),
      this.prisma.assetUsage.count({ where: { placedAt: { gte: range.gte, lt: range.lt } } }),
    ]);
    return { period: range.period, jobsCompleted, assetUsageRows };
  }
}

/** `{period: "YYYY-MM", gte, lt}` for the month before `at`. */
export function previousMonthRange(at: Date): { period: string; gte: Date; lt: Date } {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const gte = new Date(Date.UTC(year, month - 1, 1));
  const lt = new Date(Date.UTC(year, month, 1));
  const period = `${String(gte.getUTCFullYear())}-${String(gte.getUTCMonth() + 1).padStart(2, "0")}`;
  return { period, gte, lt };
}
