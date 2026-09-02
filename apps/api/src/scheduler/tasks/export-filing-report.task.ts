import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { CommonAuditService } from "../../common/audit/audit.service.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

import type { Prisma } from "@prisma/client";

export const EXPORT_FILING_REPORT_TASK = "scheduler.export-filing-report";

/** Monthly, 2nd of the month (06-data-model.md §Retention jobs: "export-filing report (B05)"). */
const EXPORT_FILING_REPORT_CRON = "0 5 2 * *";

export interface FilingReport {
  readonly period: string;
  readonly invoiceCount: number;
  readonly taxableValueMinor: number;
  readonly totalTaxMinor: number;
  readonly totalMinor: number;
}

/**
 * The monthly GSTR-1 filing summary B05 (`invoices.gstr1Period`,
 * `gstr1ReportedAt`) left for a scheduler to close out.
 *
 * Every `tax_invoice`/`credit_note` issued in the month that just ended and not
 * yet claimed by an earlier report (`gstr1Period IS NULL`) is aggregated into
 * one totals row and stamped `gstr1Period = YYYY-MM`, `gstr1ReportedAt = now`.
 * The stamp is what makes a second run idempotent — the acceptance criterion —
 * because the second run's query finds nothing left unclaimed for that period
 * and reports zero, not a duplicate of the first count.
 *
 * This computes and records the summary; it does not itself call the GST
 * portal (no filing API is integrated) — the report is what a finance operator
 * files from, same division of labour as `ProviderDeletionFollowupTask`'s
 * manual queue.
 */
@Injectable()
export class ExportFilingReportTask implements OnModuleInit {
  private readonly logger = new Logger(ExportFilingReportTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: CommonAuditService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: EXPORT_FILING_REPORT_TASK,
      cron: EXPORT_FILING_REPORT_CRON,
      run: async ({ at }) => {
        const report = await this.run(previousMonthPeriod(at));
        this.logger.log(report, "export-filing report generated");
      },
    });
  }

  /** `period` is `YYYY-MM`. Exposed directly so a test (or a manual re-run) can pick the month. */
  async run(period: string): Promise<FilingReport> {
    const due = await this.prisma.invoice.findMany({
      where: {
        gstr1Period: null,
        status: { in: ["issued", "paid"] },
        issuedAt: periodRange(period),
      },
      select: { id: true, taxableValueMinor: true, totalTaxMinor: true, totalMinor: true },
    });

    if (due.length > 0) {
      await this.prisma.invoice.updateMany({
        where: { id: { in: due.map((row) => row.id) } },
        data: { gstr1Period: period, gstr1ReportedAt: new Date() },
      });
    }

    const report: FilingReport = {
      period,
      invoiceCount: due.length,
      taxableValueMinor: due.reduce((sum, row) => sum + row.taxableValueMinor, 0),
      totalTaxMinor: due.reduce((sum, row) => sum + row.totalTaxMinor, 0),
      totalMinor: due.reduce((sum, row) => sum + row.totalMinor, 0),
    };

    await this.audit.record({
      action: "invoices.filing_report.generated",
      resource: "invoice",
      actorKind: "system",
      data: report as unknown as Prisma.InputJsonValue,
    });
    return report;
  }
}

/** `YYYY-MM` of the month before `at`. */
export function previousMonthPeriod(at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth(); // 0-based; "this month minus one" needs no -1 adjustment here
  const previous = new Date(Date.UTC(year, month - 1, 1));
  return `${String(previous.getUTCFullYear())}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `{gte, lt}` bounds for every UTC instant inside a `YYYY-MM` period. */
function periodRange(period: string): { gte: Date; lt: Date } {
  const [yearStr, monthStr] = period.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  return {
    gte: new Date(Date.UTC(year, month - 1, 1)),
    lt: new Date(Date.UTC(year, month, 1)),
  };
}
