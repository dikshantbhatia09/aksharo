import { describe, expect, it, vi } from "vitest";

import { previousMonthRange, USAGE_REPORT_TASK, UsageReportTask } from "./usage-report.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

describe("previousMonthRange", () => {
  it("bounds the whole UTC month before the given date", () => {
    const range = previousMonthRange(new Date("2026-09-15T12:00:00.000Z"));
    expect(range.period).toBe("2026-08");
    expect(range.gte.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    expect(range.lt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

function harness(jobsCompleted: number, assetUsageRows: number) {
  const jobCount = vi.fn(async () => jobsCompleted);
  const assetUsageCount = vi.fn(async () => assetUsageRows);
  const prisma = { job: { count: jobCount }, assetUsage: { count: assetUsageCount } };
  const scheduler = { register: vi.fn() };
  const task = new UsageReportTask(
    prisma as unknown as PrismaService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, jobCount, assetUsageCount, scheduler };
}

describe("registration", () => {
  it("registers a monthly cron", () => {
    const { task, scheduler } = harness(0, 0);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(USAGE_REPORT_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("run", () => {
  it("counts succeeded jobs and asset-usage rows for the given month, deterministically", async () => {
    const { task } = harness(12, 4);
    const range = previousMonthRange(new Date("2026-09-15T00:00:00.000Z"));
    const first = await task.run(range);
    const second = await task.run(range);
    expect(first).toEqual({ period: "2026-08", jobsCompleted: 12, assetUsageRows: 4 });
    expect(second).toEqual(first);
  });
});
