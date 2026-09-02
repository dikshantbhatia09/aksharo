import { describe, expect, it, vi } from "vitest";

import { ACCESS_LOG_PURGE_TASK, AccessLogPurgeTask } from "./access-log-purge.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(deleted: number[]) {
  const queue = [...deleted];
  const executeRaw = vi.fn(async () => queue.shift() ?? 0);
  const prisma = { $executeRaw: executeRaw };
  const scheduler = { register: vi.fn() };
  const task = new AccessLogPurgeTask(
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
    expect(registered.name).toBe(ACCESS_LOG_PURGE_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("deletes rows past the 1-year retention window in one pass", async () => {
    const { task, executeRaw } = harness([42]);
    await expect(task.sweep()).resolves.toBe(42);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a rerun with nothing left due deletes nothing", async () => {
    const { task } = harness([0]);
    await expect(task.sweep()).resolves.toBe(0);
  });
});
