import { describe, expect, it, vi } from "vitest";

import {
  EXPORT_FILING_REPORT_TASK,
  ExportFilingReportTask,
  previousMonthPeriod,
} from "./export-filing-report.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

describe("previousMonthPeriod", () => {
  it("is the month before the given date, in YYYY-MM", () => {
    expect(previousMonthPeriod(new Date("2026-09-02T05:00:00.000Z"))).toBe("2026-08");
  });

  it("rolls the year back across January", () => {
    expect(previousMonthPeriod(new Date("2026-01-15T05:00:00.000Z"))).toBe("2025-12");
  });
});

function harness(
  due: { id: string; taxableValueMinor: number; totalTaxMinor: number; totalMinor: number }[],
) {
  const findMany = vi.fn(async () => due);
  const updateMany = vi.fn(async () => ({ count: due.length }));
  const record = vi.fn(async () => undefined);
  const prisma = { invoice: { findMany, updateMany } };
  const audit = { record };
  const scheduler = { register: vi.fn() };
  const task = new ExportFilingReportTask(
    prisma as unknown as PrismaService,
    audit as unknown as import("../../common/audit/audit.service.js").CommonAuditService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, findMany, updateMany, record, scheduler };
}

describe("registration", () => {
  it("registers a monthly cron", () => {
    const { task, scheduler } = harness([]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(EXPORT_FILING_REPORT_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("run", () => {
  it("aggregates unclaimed invoices for the period and stamps them claimed", async () => {
    const { task, updateMany, record } = harness([
      { id: "i1", taxableValueMinor: 1_000, totalTaxMinor: 180, totalMinor: 1_180 },
      { id: "i2", taxableValueMinor: 500, totalTaxMinor: 90, totalMinor: 590 },
    ]);
    const report = await task.run("2026-08");
    expect(report).toEqual({
      period: "2026-08",
      invoiceCount: 2,
      taxableValueMinor: 1_500,
      totalTaxMinor: 270,
      totalMinor: 1_770,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["i1", "i2"] } },
      data: { gstr1Period: "2026-08", gstr1ReportedAt: expect.any(Date) as Date },
    });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a rerun for an already-claimed period finds nothing (gstr1Period IS NULL is the guard)", async () => {
    const { task, updateMany } = harness([]);
    const report = await task.run("2026-08");
    expect(report.invoiceCount).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
