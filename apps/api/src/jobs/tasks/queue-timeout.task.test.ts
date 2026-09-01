import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrisma, createFakeRedis, FakeDb } from "../../../test/fakes.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { QUEUE_TIMEOUT_INTERVAL_MS } from "../jobs.config.js";
import { QUEUE_TIMEOUT_TASK, QueueTimeoutTask } from "./queue-timeout.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { RedisService } from "../../common/redis/redis.service.js";
import type { JobsService } from "../jobs.service.js";

const WS = "01JCWS0000000000000000000A";

let db: FakeDb;
let scheduler: ScheduledTasksService;
let timeOut: ReturnType<typeof vi.fn>;
let task: QueueTimeoutTask;
/** Ids the raw candidate query should return. */
let candidates: string[];

beforeEach(() => {
  db = new FakeDb();
  candidates = [];
  const prisma = {
    ...createFakePrisma(db),
    $queryRaw: vi.fn(async () => candidates.map((id) => ({ id }))),
  } as unknown as PrismaService;

  scheduler = new ScheduledTasksService(createFakeRedis() as unknown as RedisService);
  timeOut = vi.fn(async () => true);
  task = new QueueTimeoutTask(prisma, { timeOut } as unknown as JobsService, scheduler);
});

describe("registration", () => {
  it("registers itself with the scheduler on module init", () => {
    task.onModuleInit();
    expect(scheduler.registered).toEqual([QUEUE_TIMEOUT_TASK]);
  });

  it("runs every 30 seconds", () => {
    task.onModuleInit();
    expect(QUEUE_TIMEOUT_INTERVAL_MS).toBe(30_000);
  });

  it("is driven through the scheduler, not a private timer", async () => {
    task.onModuleInit();
    const sweep = vi.spyOn(task, "sweep").mockResolvedValue(0);
    await scheduler.runNow(QUEUE_TIMEOUT_TASK);
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});

describe("sweep", () => {
  it("does nothing when no job has waited too long", async () => {
    await expect(task.sweep()).resolves.toBe(0);
    expect(timeOut).not.toHaveBeenCalled();
  });

  it("times out every candidate the query returned", async () => {
    const a = db.job({ workspaceId: WS, status: "queued" });
    const b = db.job({ workspaceId: WS, status: "queued" });
    candidates = [a.id, b.id];

    await expect(task.sweep()).resolves.toBe(2);
    expect(timeOut).toHaveBeenCalledTimes(2);
    expect(timeOut.mock.calls.map((call) => (call[0] as { id: string }).id)).toEqual([a.id, b.id]);
  });

  it("re-reads each row, so a job picked up since the scan is skipped", async () => {
    const job = db.job({ workspaceId: WS, status: "queued" });
    candidates = [job.id, "01JCGONE00000000000000000A"];

    await expect(task.sweep()).resolves.toBe(1);
    expect(timeOut).toHaveBeenCalledTimes(1);
  });

  it("counts only the jobs the conditional update actually won", async () => {
    const a = db.job({ workspaceId: WS, status: "queued" });
    const b = db.job({ workspaceId: WS, status: "queued" });
    candidates = [a.id, b.id];
    timeOut.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(task.sweep()).resolves.toBe(1);
  });
});
