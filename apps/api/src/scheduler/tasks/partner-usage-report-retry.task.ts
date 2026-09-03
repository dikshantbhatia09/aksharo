import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { PartnerCatalogueService } from "../../partner-catalogue/partner-catalogue.service.js";

export const PARTNER_USAGE_REPORT_RETRY_TASK = "scheduler.partner-usage-report-retry";

/** Every 15 minutes — usage reporting (B14b `export.completed` precedent) is
 * best-effort at export time; this is the retry sweep for whatever failed. */
const PARTNER_USAGE_REPORT_RETRY_CRON = "*/15 * * * *";
const BATCH = 200;

export interface PartnerUsageReportRetryReport {
  readonly reported: number;
  readonly stillFailing: number;
}

/**
 * D04b (brief §3: "usage reports emitted on export.completed for renders
 * that used partner assets ... retried via the B16 scheduler"). The real
 * emission happens inline, at `export.completed` time (outside this work
 * package's file boundary — the render/export completion handler); this
 * task is the retry half, over `asset_usages` rows a cloud render already
 * finished (`exportedAt` set) and stamped with the grant it drew on
 * (`clearanceGrantId`) but has not yet reported (`reportedAt` still null).
 *
 * Skipped, not retried forever: while `assets.partnerCatalogue` is off, or a
 * grant no longer resolves (revoked/expired/deleted), the row is left with
 * `reportedAt` still null — a human-visible signal via the count this task
 * logs, rather than a silent write. Idempotent: re-running finds only the
 * rows still unreported.
 */
@Injectable()
export class PartnerUsageReportRetryTask implements OnModuleInit {
  private readonly logger = new Logger(PartnerUsageReportRetryTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly partnerCatalogue: PartnerCatalogueService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PARTNER_USAGE_REPORT_RETRY_TASK,
      cron: PARTNER_USAGE_REPORT_RETRY_CRON,
      run: async () => {
        const report = await this.sweep();
        if (report.reported > 0 || report.stillFailing > 0) {
          this.logger.log(report, "partner catalogue usage reports retried");
        }
      },
    });
  }

  async sweep(): Promise<PartnerUsageReportRetryReport> {
    const due = await this.prisma.assetUsage.findMany({
      where: { exportedAt: { not: null }, reportedAt: null, clearanceGrantId: { not: null } },
      select: { id: true, clearanceGrantId: true, exportId: true },
      take: BATCH,
    });
    if (due.length === 0) return { reported: 0, stillFailing: 0 };

    let reported = 0;
    let stillFailing = 0;

    for (const row of due) {
      if (row.clearanceGrantId === null || row.exportId === null) {
        stillFailing += 1;
        continue;
      }
      try {
        const result = await this.partnerCatalogue.reportUsage({
          grantId: row.clearanceGrantId,
          exportId: row.exportId,
        });
        await this.prisma.assetUsage.update({
          where: { id: row.id },
          data: { reportedAt: result.reportedAt, reportRef: result.reportRef },
        });
        reported += 1;
      } catch (error) {
        this.logger.warn(
          { assetUsageId: row.id, err: error instanceof Error ? error.message : String(error) },
          "partner usage report retry failed; left for the next pass",
        );
        stillFailing += 1;
      }
    }

    return { reported, stillFailing };
  }
}
