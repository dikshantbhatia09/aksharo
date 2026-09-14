import { describe, expect, it, vi } from "vitest";

import { QUEUE_DEPTH_TASK, QueueDepthTask } from "./queue-depth.task.js";
import { QUEUE_NAMES } from "../contracts/queue-names.js";

import type { MetricsService } from "../../common/metrics/metrics.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import type { QueueRegistry } from "../queue.registry.js";

type Counts = Partial<Record<"wait" | "prioritized" | "delayed" | "active", number>>;

function harness(options: { counts?: Counts; failOn?: string } = {}) {
  const counts = options.counts ?? { wait: 3, prioritized: 7, delayed: 1, active: 2 };
  const recorded: { queue: string; state: string; depth: number }[] = [];

  const queues = {
    queue: (name: string) => ({
      getJobCounts: vi.fn(async () => {
        if (options.failOn === name) throw new Error("Redis unreachable");
        return counts;
      }),
    }),
  } as unknown as QueueRegistry;

  const metrics = {
    queueDepth: (queue: string, state: string, depth: number) => {
      recorded.push({ queue, state, depth });
    },
  } as unknown as MetricsService;

  const registered: { name: string; everyMs?: number }[] = [];
  const scheduler = {
    register: (task: { name: string; everyMs?: number }) => registered.push(task),
  } as unknown as ScheduledTasksService;

  return { task: new QueueDepthTask(queues, metrics, scheduler), recorded, registered };
}

describe("QueueDepthTask", () => {
  it("registers itself on the shared scheduler, so one replica samples per tick", () => {
    const { task, registered } = harness();
    task.onModuleInit();

    expect(registered).toHaveLength(1);
    expect(registered[0]?.name).toBe(QUEUE_DEPTH_TASK);
    // Every replica publishing its own copy of a queue-wide number would make a
    // sum() across pods N times the truth.
    expect(registered[0]?.everyMs).toBeGreaterThan(0);
  });

  /**
   * The bug this exists for: every job the API enqueues carries a priority, and
   * BullMQ puts a prioritised job in the `prioritized` sorted set rather than the
   * `wait` list. A scaler watching only `wait` saw an almost-always-empty list
   * while the real backlog grew beside it (P0-04).
   */
  it("reports prioritized separately from waiting", async () => {
    const { task, recorded } = harness({ counts: { wait: 0, prioritized: 42 } });
    await task.sample();

    const probe = recorded.filter((row) => row.queue === "media.probe");
    expect(probe).toContainEqual({ queue: "media.probe", state: "waiting", depth: 0 });
    expect(probe).toContainEqual({ queue: "media.probe", state: "prioritized", depth: 42 });
  });

  it("covers every contract queue and every state", async () => {
    const { task, recorded } = harness();
    await task.sample();

    expect(new Set(recorded.map((row) => row.queue)).size).toBe(QUEUE_NAMES.length);
    for (const state of ["waiting", "prioritized", "delayed", "active"]) {
      expect(recorded.filter((row) => row.state === state)).toHaveLength(QUEUE_NAMES.length);
    }
  });

  /** A series that disappears looks exactly like a healthy one never scraped. */
  it("publishes an explicit zero for a drained queue", async () => {
    const { task, recorded } = harness({ counts: {} });
    await task.sample();
    expect(recorded.every((row) => row.depth === 0)).toBe(true);
    expect(recorded).toHaveLength(QUEUE_NAMES.length * 4);
  });

  it("keeps sampling the other queues when one is unreachable", async () => {
    const { task, recorded } = harness({ failOn: "ai.transcribe" });
    await expect(task.sample()).resolves.toBeUndefined();

    expect(recorded.some((row) => row.queue === "ai.transcribe")).toBe(false);
    expect(new Set(recorded.map((row) => row.queue)).size).toBe(QUEUE_NAMES.length - 1);
  });
});
