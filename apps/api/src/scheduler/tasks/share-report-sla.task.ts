import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

export const SHARE_REPORT_SLA_TASK = "scheduler.share-report-sla";

/** Daily (06-data-model.md §Retention jobs: "share-report SLA checks"). */
const SHARE_REPORT_SLA_CRON = "0 * * * *";

/**
 * `share_reports.dueAt` is 3 h for NCII, 36 h otherwise (IT Rules, that model's
 * own schema comment) — a report the platform has not resolved by then is a
 * compliance breach, not a routine backlog item. This task does not resolve
 * anything itself (that is a human moderation action, B13's admin surface); it
 * finds every unresolved report already past its SLA and writes one
 * `audit_log` summary an operator's alerting can page on, the same pattern
 * `ProviderDeletionFollowupTask` uses for its own manual queue.
 *
 * Runs hourly, not daily, because the tightest SLA here is 3 hours — a daily
 * check would let an NCII report sit unflagged for most of a day.
 */
@Injectable()
export class ShareReportSlaTask implements OnModuleInit {
  private readonly logger = new Logger(ShareReportSlaTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: SHARE_REPORT_SLA_TASK,
      cron: SHARE_REPORT_SLA_CRON,
      run: async ({ at }) => {
        const breached = await this.sweep(at);
        if (breached > 0) this.logger.warn({ breached }, "share reports past SLA");
      },
    });
  }

  async sweep(now: Date = new Date()): Promise<number> {
    const overdue = await this.prisma.shareReport.findMany({
      where: { resolvedAt: null, dueAt: { lt: now } },
      select: { id: true, category: true, dueAt: true },
    });
    if (overdue.length === 0) return 0;

    await this.audit.record({
      action: "privacy.share_report.sla_breached",
      resource: "share_report",
      actorKind: "system",
      data: {
        count: overdue.length,
        ids: overdue.map((row) => row.id),
        categories: [...new Set(overdue.map((row) => row.category))],
      },
    });
    return overdue.length;
  }
}
