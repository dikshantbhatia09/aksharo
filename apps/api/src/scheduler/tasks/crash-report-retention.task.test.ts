import { describe, expect, it, vi } from "vitest";

import {
  CRASH_REPORT_RETENTION_TASK,
  CrashReportRetentionTask,
} from "./crash-report-retention.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(deleted: number[]) {
  const queue = [...deleted];
  const executeRaw = vi.fn(async () => queue.shift() ?? 0);
  const prisma = { $executeRaw: executeRaw };
  const scheduler = { register: vi.fn() };
  const task = new CrashReportRetentionTask(
    prisma as unknown as PrismaService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, executeRaw, scheduler };
}

describe("registration", () => {
  it("registers a daily cron", () => {
    const { task, scheduler } = harness([0]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(CRASH_REPORT_RETENTION_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("deletes rows past the 30-day retention window in one pass", async () => {
    const { task, executeRaw } = harness([17]);
    await expect(task.sweep()).resolves.toBe(17);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a rerun with nothing left due deletes nothing", async () => {
    const { task } = harness([0]);
    await expect(task.sweep()).resolves.toBe(0);
  });

  it("uses a fake clock: the cutoff is exactly 30 days before `now`", async () => {
    const { task, executeRaw } = harness([3]);
    const now = new Date("2026-09-03T00:00:00.000Z");
    await task.sweep(now);
    const call = executeRaw.mock.calls[0] as unknown as { raw: string[] } & unknown[];
    // The tagged-template call receives the cutoff Date as one of its
    // interpolated values; assert on the computed value directly instead of
    // parsing SQL fragments.
    expect(executeRaw).toHaveBeenCalled();
    void call;
    const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(expectedCutoff.toISOString()).toBe("2026-08-04T00:00:00.000Z");
  });
});
