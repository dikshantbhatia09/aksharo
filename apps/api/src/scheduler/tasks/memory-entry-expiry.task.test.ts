import { describe, expect, it, vi } from "vitest";

import { MEMORY_ENTRY_EXPIRY_TASK, MemoryEntryExpiryTask } from "./memory-entry-expiry.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

function harness(batches: { id: string }[][]) {
  const queue = [...batches];
  const findMany = vi.fn(async () => queue.shift() ?? []);
  const deleteMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => ({
    count: where.id.in.length,
  }));
  const prisma = { memoryEntry: { findMany, deleteMany } };
  const scheduler = { register: vi.fn() };
  const task = new MemoryEntryExpiryTask(
    prisma as unknown as PrismaService,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, prisma, scheduler };
}

describe("registration", () => {
  it("registers a daily cron", () => {
    const { task, scheduler } = harness([[]]);
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(MEMORY_ENTRY_EXPIRY_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("sweep", () => {
  it("deletes every expired row and stops when a batch comes back short", async () => {
    const { task } = harness([[{ id: "a" }, { id: "b" }]]);
    await expect(task.sweep()).resolves.toBe(2);
  });

  it("does nothing when nothing is due", async () => {
    const { task } = harness([[]]);
    await expect(task.sweep()).resolves.toBe(0);
  });
});
