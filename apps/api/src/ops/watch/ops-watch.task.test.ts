import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CLEAR_AFTER_MS } from "./alert-state.js";
import { OPS_WATCH_INTERVAL_MS, OPS_WATCH_TASK, OpsWatchTask } from "./ops-watch.task.js";
import { createFakeRedis } from "../../../test/fakes.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";

import type { AlertSender, OpsAlert } from "./alert-sender.js";
import type { AlertRecord, AlertStateStore, Finding } from "./alert-state.js";
import type { CheckOutput, OpsWatchChecks, WatchCheck } from "./ops-watch.checks.js";
import type { RedisService } from "../../common/redis/redis.service.js";

const T0 = new Date("2026-09-27T12:00:00.000Z");
const MIN = 60_000;

const DISK: Finding = {
  check: "disk.low",
  subject: "C:\\",
  severity: "critical",
  line: "C:\\ 3.0 GiB free of 476.0 GiB (0.6%)",
};

const NO_WORKER: Finding = {
  check: "queues.no-worker",
  subject: "media.probe",
  severity: "critical",
  line: "media.probe: no worker connected",
};

const DEAD: Finding = {
  check: "dlq.new",
  subject: "01D",
  severity: "notice",
  line: "media.proxy job 01J: media/probe_failed",
};

let diskFindings: Finding[];
let queueCheck: () => Promise<CheckOutput>;
let dlqFindings: Finding[];
let stored: Map<string, AlertRecord>;
let sent: OpsAlert[];
let deliver: boolean;
let scheduler: ScheduledTasksService;
let task: OpsWatchTask;

function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * MIN);
}

beforeEach(() => {
  diskFindings = [];
  queueCheck = async () => ({ findings: [], partial: false });
  dlqFindings = [];
  stored = new Map();
  sent = [];
  deliver = true;

  const checks = {
    all: (): WatchCheck[] => [
      { id: "disk.low", run: async () => ({ findings: diskFindings, partial: false }) },
      { id: "queues.no-worker", run: async () => queueCheck() },
      { id: "dlq.new", run: async () => ({ findings: dlqFindings, partial: false }) },
    ],
  } as unknown as OpsWatchChecks;
  const store = {
    load: async () => new Map(stored),
    put: async (entries: ReadonlyArray<readonly [string, AlertRecord]>) => {
      for (const [key, record] of entries) stored.set(key, record);
    },
    remove: async (keys: readonly string[]) => {
      for (const key of keys) stored.delete(key);
    },
  } as unknown as AlertStateStore;
  const sender = {
    send: async (alert: OpsAlert) => {
      if (!deliver) return false;
      sent.push(alert);
      return true;
    },
  } as unknown as AlertSender;

  scheduler = new ScheduledTasksService(createFakeRedis() as unknown as RedisService);
  task = new OpsWatchTask(checks, store, sender, scheduler);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registration", () => {
  it("registers as ops.watch, every minute, driven by the scheduler", async () => {
    task.onModuleInit();
    expect(scheduler.registered).toEqual([OPS_WATCH_TASK]);
    expect(OPS_WATCH_TASK).toBe("ops.watch");
    expect(OPS_WATCH_INTERVAL_MS).toBe(60_000);

    diskFindings = [DISK];
    await scheduler.runNow(OPS_WATCH_TASK);
    await scheduler.runNow(OPS_WATCH_TASK);
    expect(sent.map((alert) => alert.title)).toEqual(["Aksharo ops: disk space low"]);
  });
});

describe("tick", () => {
  it("alerts once two passes have seen it, stays quiet, and sends one 'cleared' after it has been gone a while", async () => {
    diskFindings = [DISK];
    await expect(task.tick(at(0))).resolves.toMatchObject({ findings: 1, sent: 0, unsent: 0 });
    await expect(task.tick(at(1))).resolves.toMatchObject({ findings: 1, sent: 1, unsent: 0 });
    expect(sent[0]).toMatchObject({ priority: 5, body: `new: ${DISK.line}` });

    await expect(task.tick(at(2))).resolves.toMatchObject({ sent: 0 });

    diskFindings = [];
    await expect(task.tick(at(3))).resolves.toMatchObject({ sent: 0 });
    await task.tick(new Date(at(3).getTime() + CLEAR_AFTER_MS));
    expect(sent.map((alert) => alert.title)).toEqual([
      "Aksharo ops: disk space low",
      "Aksharo ops: cleared - disk space low",
    ]);
    expect(stored.size).toBe(0);
  });

  it("does not record an alert the webhook did not take, so the next pass sends it again", async () => {
    diskFindings = [DISK];
    await task.tick(at(0));
    deliver = false;
    await expect(task.tick(at(1))).resolves.toMatchObject({ sent: 0, unsent: 1 });
    expect(stored.get("disk.low|C:\\")?.pending).toBe(true);

    deliver = true;
    await expect(task.tick(at(2))).resolves.toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });

  it("writes an event the webhook did not take down as owed, and sends it once the webhook is back", async () => {
    dlqFindings = [DEAD];
    deliver = false;
    await expect(task.tick(at(0))).resolves.toMatchObject({ unsent: 1 });
    expect(stored.get("dlq.new|01D")).toMatchObject({ unsent: true });

    // Past the checks' lookback: the dead letter is no longer found at all.
    dlqFindings = [];
    deliver = true;
    await expect(task.tick(at(30))).resolves.toMatchObject({ sent: 1 });
    expect(sent[0]?.body).toBe(DEAD.line);
    expect(stored.get("dlq.new|01D")?.unsent).toBeUndefined();
  });

  it("reports a check that failed on two passes as its own alert, and keeps running the others", async () => {
    diskFindings = [DISK];
    queueCheck = async () => {
      throw new Error("ERR unknown command 'CLIENT', with args beginning with: 'LIST'");
    };

    await task.tick(at(0));
    const report = await task.tick(at(1));

    expect(report).toMatchObject({ failedChecks: ["queues.no-worker"], sent: 2 });
    const blind = sent.find((alert) => alert.title === "Aksharo ops: 1 ops check could not run");
    expect(blind?.body).toBe("new: queues.no-worker could not run (see the API log)");
    // The error text stays in the log; the phone gets the check's name only.
    expect(blind?.body).not.toContain("CLIENT");
  });

  it("does not clear a check's open problems while that check cannot look", async () => {
    queueCheck = async () => ({ findings: [NO_WORKER], partial: false });
    await task.tick(at(0));
    await task.tick(at(1));
    queueCheck = async () => {
      throw new Error("redis went away");
    };

    await task.tick(at(2));
    await task.tick(new Date(at(2).getTime() + CLEAR_AFTER_MS));

    expect(sent.some((alert) => alert.title.includes("cleared"))).toBe(false);
    expect(stored.has("queues.no-worker|media.probe")).toBe(true);
  });

  it("passes a check's 'saw only part' on, so its unseen problems are not cleared", async () => {
    queueCheck = async () => ({ findings: [NO_WORKER], partial: false });
    await task.tick(at(0));
    await task.tick(at(1));
    queueCheck = async () => ({ findings: [], partial: true });

    await task.tick(at(2));
    await task.tick(new Date(at(2).getTime() + CLEAR_AFTER_MS));

    expect(sent.map((alert) => alert.title)).toEqual(["Aksharo ops: no worker on 1 queue"]);
    expect(stored.get("queues.no-worker|media.probe")?.goneSince).toBeUndefined();
  });

  it("gives up on a check that hangs instead of hanging the watch", async () => {
    vi.useFakeTimers();
    queueCheck = async () => new Promise<CheckOutput>(() => undefined);

    const pass = task.tick(T0);
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pass).resolves.toMatchObject({ failedChecks: ["queues.no-worker"] });
  });

  it("skips a tick while the previous pass is still running", async () => {
    let release: (output: CheckOutput) => void = () => undefined;
    queueCheck = async () =>
      new Promise<CheckOutput>((resolve) => {
        release = resolve;
      });

    const first = task.tick(T0);
    await expect(task.tick(T0)).resolves.toBeNull();
    release({ findings: [], partial: false });
    await expect(first).resolves.not.toBeNull();
  });
});
