import { beforeEach, describe, expect, it, vi } from "vitest";

import { JOB_EVENT_RETENTION_TASK, JobEventRetentionTask } from "./job-event-retention.task.js";
import { JOB_EVENT_RETENTION_BATCH, JOB_EVENT_RETENTION_MAX_BATCHES } from "../jobs.config.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

interface Harness {
  task: JobEventRetentionTask;
  executeRaw: ReturnType<typeof vi.fn>;
  scheduler: { register: ReturnType<typeof vi.fn> };
}

function harness(deleted: number[]): Harness {
  const queue = [...deleted];
  const executeRaw = vi.fn(async () => queue.shift() ?? 0);
  const prisma = { $executeRaw: executeRaw } as unknown as PrismaService;
  const scheduler = { register: vi.fn() };
  const task = new JobEventRetentionTask(prisma, scheduler as unknown as ScheduledTasksService);
  return { task, executeRaw, scheduler };
}

let h: Harness;
beforeEach(() => {
  h = harness([0]);
});

describe("registration", () => {
  it("registers a nightly cron on the scheduler primitive, not a timer", () => {
    h.task.onModuleInit();
    const registered = h.scheduler.register.mock.calls[0]?.[0] as {
      name: string;
      cron?: string;
      everyMs?: number;
    };
    expect(registered.name).toBe(JOB_EVENT_RETENTION_TASK);
    expect(registered.cron).toBeTypeOf("string");
    expect(registered.everyMs).toBeUndefined();
  });
});

describe("sweep", () => {
  it("stops after one pass when the batch came back short", async () => {
    h = harness([12]);
    await expect(h.task.sweep()).resolves.toBe(12);
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("keeps going while every pass fills its batch", async () => {
    h = harness([JOB_EVENT_RETENTION_BATCH, JOB_EVENT_RETENTION_BATCH, 3]);
    await expect(h.task.sweep()).resolves.toBe(JOB_EVENT_RETENTION_BATCH * 2 + 3);
    expect(h.executeRaw).toHaveBeenCalledTimes(3);
  });

  it("gives up at the batch ceiling, so one bad night cannot run into the morning", async () => {
    h = harness(
      new Array<number>(JOB_EVENT_RETENTION_MAX_BATCHES + 5).fill(JOB_EVENT_RETENTION_BATCH),
    );
    await h.task.sweep();
    expect(h.executeRaw).toHaveBeenCalledTimes(JOB_EVENT_RETENTION_MAX_BATCHES);
  });

  it("does nothing, quietly, when there is nothing to delete", async () => {
    h = harness([0]);
    await expect(h.task.sweep()).resolves.toBe(0);
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
  });
});
