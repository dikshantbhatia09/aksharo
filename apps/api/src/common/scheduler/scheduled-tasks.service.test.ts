import { beforeEach, describe, expect, it, vi } from "vitest";

import { ScheduledTasksService } from "./scheduled-tasks.service.js";
import {
  SCHEDULER_QUEUE,
  schedulerEnabled,
  schedulerMode,
  schedulerTaskAllowlist,
} from "./scheduler.types.js";
import { createFakeRedis } from "../../../test/fakes.js";

import type { ScheduledTaskContext } from "./scheduler.types.js";
import type { RedisService } from "../redis/redis.service.js";

let scheduler: ScheduledTasksService;

beforeEach(() => {
  scheduler = new ScheduledTasksService(createFakeRedis() as unknown as RedisService);
});

describe("register", () => {
  it("keeps the tasks in registration order", () => {
    scheduler.register({ name: "a.one", everyMs: 1_000, run: async () => undefined });
    scheduler.register({ name: "b.two", cron: "0 3 * * *", run: async () => undefined });
    expect(scheduler.registered).toEqual(["a.one", "b.two"]);
  });

  it("insists on exactly one of everyMs and cron", () => {
    expect(() => scheduler.register({ name: "bad", run: async () => undefined })).toThrow(
      /exactly one/,
    );
    expect(() =>
      scheduler.register({
        name: "bad",
        everyMs: 1_000,
        cron: "* * * * *",
        run: async () => undefined,
      }),
    ).toThrow(/exactly one/);
  });

  it("refuses a duplicate name, which would silently shadow a schedule", () => {
    scheduler.register({ name: "a.one", everyMs: 1_000, run: async () => undefined });
    expect(() =>
      scheduler.register({ name: "a.one", everyMs: 2_000, run: async () => undefined }),
    ).toThrow(/already registered/);
  });
});

describe("runNow", () => {
  it("runs a task in this process, bypassing the queue", async () => {
    const run = vi.fn<(context: ScheduledTaskContext) => Promise<void>>(async () => undefined);
    scheduler.register({ name: "a.one", everyMs: 1_000, run });

    await scheduler.runNow("a.one");

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ name: "a.one", at: expect.any(Date) });
  });

  it("throws for a task nobody registered", async () => {
    await expect(scheduler.runNow("nope")).rejects.toThrow(/No scheduled task/);
  });

  it("propagates the task's failure rather than swallowing it", async () => {
    scheduler.register({
      name: "a.one",
      everyMs: 1_000,
      run: async () => {
        throw new Error("boom");
      },
    });
    await expect(scheduler.runNow("a.one")).rejects.toThrow("boom");
  });
});

describe("lifecycle", () => {
  it("starts nothing when the scheduler is disabled", async () => {
    const previous = process.env["MONTAJ_SCHEDULER_DISABLED"];
    process.env["MONTAJ_SCHEDULER_DISABLED"] = "1";
    try {
      expect(schedulerEnabled()).toBe(false);
      scheduler.register({ name: "a.one", everyMs: 1_000, run: async () => undefined });
      await expect(scheduler.onApplicationBootstrap()).resolves.toBeUndefined();
      // Still runnable by hand; only the Redis-backed timer is off.
      await expect(scheduler.runNow("a.one")).resolves.toBeUndefined();
      await expect(scheduler.onModuleDestroy()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env["MONTAJ_SCHEDULER_DISABLED"];
      else process.env["MONTAJ_SCHEDULER_DISABLED"] = previous;
    }
  });

  it("uses an internal queue that is not one of the CONTRACTS §3 queues", () => {
    expect(SCHEDULER_QUEUE).toBe("scheduler");
  });

  it("is enabled unless the variable says otherwise", () => {
    expect(schedulerEnabled({})).toBe(true);
    expect(schedulerEnabled({ MONTAJ_SCHEDULER_DISABLED: "0" })).toBe(true);
    expect(schedulerEnabled({ MONTAJ_SCHEDULER_DISABLED: "1" })).toBe(false);
  });
});

describe("MONTAJ_SCHEDULER_TASKS", () => {
  it("is no allowlist only when unset", () => {
    expect(schedulerTaskAllowlist({})).toBeNull();
  });

  it("is an empty allowlist when set but blank, so a stray `MONTAJ_SCHEDULER_TASKS=` runs nothing", () => {
    expect(schedulerTaskAllowlist({ MONTAJ_SCHEDULER_TASKS: "" })?.size).toBe(0);
    expect(schedulerTaskAllowlist({ MONTAJ_SCHEDULER_TASKS: " , ,  " })?.size).toBe(0);
    expect(schedulerMode({ MONTAJ_SCHEDULER_TASKS: "" }).run).toBe(false);
    expect(
      schedulerMode({ MONTAJ_SCHEDULER_DISABLED: "0", MONTAJ_SCHEDULER_TASKS: " , " }).run,
    ).toBe(false);
  });

  it("reads a comma or whitespace separated list of task names", () => {
    const allow = schedulerTaskAllowlist({
      MONTAJ_SCHEDULER_TASKS: " jobs.dlq-depth,ops.watch\n scheduler.media-retention ,,",
    });
    expect([...(allow ?? [])]).toEqual([
      "jobs.dlq-depth",
      "ops.watch",
      "scheduler.media-retention",
    ]);
  });

  it("never overrides MONTAJ_SCHEDULER_DISABLED=1: the kill switch is authoritative", () => {
    // What a one-shot process or a test run looks like when a task list leaks
    // in from a `.env` or a shell: it must still start no worker.
    expect(
      schedulerMode({ MONTAJ_SCHEDULER_DISABLED: "1", MONTAJ_SCHEDULER_TASKS: "ops.watch" }).run,
    ).toBe(false);
  });

  it("runs only the listed tasks with the kill switch off, which is how production runs", () => {
    const mode = schedulerMode({
      MONTAJ_SCHEDULER_DISABLED: "0",
      MONTAJ_SCHEDULER_TASKS: "ops.watch",
    });
    expect(mode.run).toBe(true);
    expect([...(mode.allow ?? [])]).toEqual(["ops.watch"]);
  });

  it("keeps the scheduler off when disabled with no allowlist", () => {
    expect(schedulerMode({ MONTAJ_SCHEDULER_DISABLED: "1" })).toEqual({ run: false, allow: null });
  });

  it("runs everything when neither variable is set", () => {
    expect(schedulerMode({})).toEqual({ run: true, allow: null });
  });

  it("only ever narrows: an allowlist without the kill switch still limits the tasks", () => {
    const mode = schedulerMode({ MONTAJ_SCHEDULER_TASKS: "jobs.queue-depth" });
    expect(mode.run).toBe(true);
    expect(mode.allow?.has("affiliates.payout-batch")).toBe(false);
  });
});
