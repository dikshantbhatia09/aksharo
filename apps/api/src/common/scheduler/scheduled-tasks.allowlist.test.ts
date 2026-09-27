import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ScheduledTasksService } from "./scheduled-tasks.service.js";
import { SCHEDULER_KEEP_COMPLETED, SCHEDULER_KEEP_FAILED } from "./scheduler.types.js";
import { createFakeRedis } from "../../../test/fakes.js";

import type { ScheduledTaskContext } from "./scheduler.types.js";
import type { RedisService } from "../redis/redis.service.js";

/**
 * The allowlist at bootstrap, against a stand-in BullMQ: what gets installed,
 * what leftover schedules get removed, and what a tick is allowed to run.
 *
 * `bullmq` is replaced for this file only (Vitest hoists `vi.mock` per file), so
 * the `Queue` and `Worker` the service constructs record their calls instead of
 * dialling Redis.
 */
const bull = vi.hoisted(() => {
  const state = {
    /** Schedules "in Redis" before this boot: leftovers from an earlier process. */
    existing: [] as { key: string; name: string }[],
    upserted: [] as string[],
    removed: [] as string[],
    /** The processor the service handed its Worker, to fire a tick by hand. */
    processor: undefined as ((job: { name: string }) => Promise<void>) | undefined,
    workers: 0,
    /** The options the service gave its Worker, and each schedule's job template. */
    workerOptions: undefined as Record<string, unknown> | undefined,
    templates: [] as { name?: string; opts?: Record<string, unknown> }[],
  };

  class FakeQueue {
    on(): this {
      return this;
    }
    async upsertJobScheduler(
      id: string,
      _repeat: unknown,
      template: { name?: string; opts?: Record<string, unknown> },
    ): Promise<void> {
      state.upserted.push(id);
      state.templates.push(template);
    }
    async getJobSchedulers(): Promise<{ key: string; name: string }[]> {
      return state.existing;
    }
    async removeJobScheduler(id: string): Promise<boolean> {
      state.removed.push(id);
      return true;
    }
    async close(): Promise<void> {
      /* nothing to close */
    }
  }

  class FakeWorker {
    constructor(
      _queue: string,
      processor: (job: { name: string }) => Promise<void>,
      options: Record<string, unknown>,
    ) {
      state.processor = processor;
      state.workers += 1;
      state.workerOptions = options;
    }
    on(): this {
      return this;
    }
    async close(): Promise<void> {
      /* nothing to close */
    }
  }

  return { state, FakeQueue, FakeWorker };
});

vi.mock("bullmq", () => ({ Queue: bull.FakeQueue, Worker: bull.FakeWorker }));

let scheduler: ScheduledTasksService;
let ran: string[];

function task(name: string) {
  return {
    name,
    everyMs: 60_000,
    run: async (context: ScheduledTaskContext) => {
      ran.push(context.name);
    },
  };
}

beforeEach(() => {
  bull.state.existing = [];
  bull.state.upserted = [];
  bull.state.removed = [];
  bull.state.processor = undefined;
  bull.state.workers = 0;
  bull.state.workerOptions = undefined;
  bull.state.templates = [];
  ran = [];
  scheduler = new ScheduledTasksService(createFakeRedis() as unknown as RedisService);
  scheduler.register(task("ops.watch"));
  scheduler.register(task("jobs.dlq-depth"));
  scheduler.register(task("affiliates.payout-batch"));
  scheduler.register(task("scheduler.renewal-dunning"));
});

afterEach(async () => {
  await scheduler.onModuleDestroy();
  vi.unstubAllEnvs();
});

describe("with an allowlist and the kill switch off (production)", () => {
  beforeEach(() => {
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "0");
    vi.stubEnv("MONTAJ_SCHEDULER_TASKS", "ops.watch, jobs.dlq-depth, jobs.not-a-task");
  });

  it("starts the worker and installs only the listed tasks", async () => {
    await scheduler.onApplicationBootstrap();

    expect(bull.state.workers).toBe(1);
    expect(bull.state.upserted).toEqual(["ops.watch", "jobs.dlq-depth"]);
    expect(scheduler.scheduled).toEqual(["ops.watch", "jobs.dlq-depth"]);
    // Still registered — the admin console lists and can run them by hand.
    expect(scheduler.registered).toContain("affiliates.payout-batch");
  });

  it("removes schedules an earlier boot left in Redis for unlisted tasks", async () => {
    bull.state.existing = [
      { key: "affiliates.payout-batch", name: "affiliates.payout-batch" },
      { key: "ops.watch", name: "ops.watch" },
      { key: "legacy.gone", name: "legacy.gone" },
    ];

    await scheduler.onApplicationBootstrap();

    expect(bull.state.removed).toEqual(["affiliates.payout-batch", "legacy.gone"]);
  });

  it("drops a tick for an unlisted task instead of running it, and removes its schedule", async () => {
    await scheduler.onApplicationBootstrap();

    await bull.state.processor?.({ name: "affiliates.payout-batch" });
    await bull.state.processor?.({ name: "ops.watch" });

    expect(ran).toEqual(["ops.watch"]);
    expect(bull.state.removed).toEqual(["affiliates.payout-batch"]);
  });

  it("installs a listed task registered after bootstrap, and not an unlisted one", async () => {
    await scheduler.onApplicationBootstrap();
    bull.state.upserted = [];

    scheduler.register(task("jobs.not-a-task"));
    scheduler.register(task("credits.grant-reset"));
    await Promise.resolve();

    expect(bull.state.upserted).toEqual(["jobs.not-a-task"]);
  });

  it("still lets an operator run an unlisted task by hand", async () => {
    await scheduler.onApplicationBootstrap();
    await scheduler.runNow("scheduler.renewal-dunning");
    expect(ran).toEqual(["scheduler.renewal-dunning"]);
  });
});

describe("with MONTAJ_SCHEDULER_DISABLED=1", () => {
  it("starts nothing even when a task list leaked in from a .env or a shell", async () => {
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "1");
    vi.stubEnv("MONTAJ_SCHEDULER_TASKS", "ops.watch,jobs.lease-reaper");

    await scheduler.onApplicationBootstrap();

    expect(bull.state.workers).toBe(0);
    expect(bull.state.upserted).toEqual([]);
    expect(scheduler.scheduled).toEqual([]);
  });
});

describe("with MONTAJ_SCHEDULER_TASKS set but empty", () => {
  it("starts nothing, rather than reading a blank list as 'every task'", async () => {
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "0");
    vi.stubEnv("MONTAJ_SCHEDULER_TASKS", "");

    await scheduler.onApplicationBootstrap();

    expect(bull.state.workers).toBe(0);
    expect(bull.state.upserted).toEqual([]);
  });
});

describe("finished ticks", () => {
  it("are pruned by the worker and by every schedule's template, not kept forever", async () => {
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "0");
    vi.stubEnv("MONTAJ_SCHEDULER_TASKS", undefined);

    await scheduler.onApplicationBootstrap();

    const keep = {
      removeOnComplete: { count: SCHEDULER_KEEP_COMPLETED },
      removeOnFail: { count: SCHEDULER_KEEP_FAILED },
    };
    expect(bull.state.workerOptions).toMatchObject(keep);
    expect(bull.state.templates).toHaveLength(4);
    for (const template of bull.state.templates) {
      expect(template).toMatchObject({ opts: keep });
    }
  });
});

describe("without an allowlist", () => {
  beforeEach(() => {
    // Unset, not blank: blank is an empty list, which runs nothing.
    vi.stubEnv("MONTAJ_SCHEDULER_TASKS", undefined);
  });

  it("installs every task and leaves unknown schedules alone", async () => {
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "0");
    bull.state.existing = [{ key: "legacy.gone", name: "legacy.gone" }];

    await scheduler.onApplicationBootstrap();

    expect(bull.state.upserted).toEqual([
      "ops.watch",
      "jobs.dlq-depth",
      "affiliates.payout-batch",
      "scheduler.renewal-dunning",
    ]);
    expect(bull.state.removed).toEqual([]);
  });

  it("starts nothing at all under MONTAJ_SCHEDULER_DISABLED=1", async () => {
    vi.stubEnv("MONTAJ_SCHEDULER_DISABLED", "1");

    await scheduler.onApplicationBootstrap();

    expect(bull.state.workers).toBe(0);
    expect(bull.state.upserted).toEqual([]);
    expect(scheduler.scheduled).toEqual([]);
  });
});
