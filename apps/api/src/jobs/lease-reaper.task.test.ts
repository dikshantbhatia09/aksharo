import { beforeEach, describe, expect, it, vi } from "vitest";

import { queueForJobType } from "./contracts/queue-names.js";
import { heartbeatIntervalMs } from "./jobs.config.js";
import {
  JOB_STALLED_CODE,
  JOB_STALLED_MESSAGE,
  LEASE_REAPER_BATCH,
  LEASE_REAPER_INTERVAL_MS,
  LEASE_REAPER_TASK,
  LeaseReaperTask,
  isSilent,
  lastSignalAt,
} from "./lease-reaper.task.js";
import { createFakeRedis } from "../../test/fakes.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";

import type { JobCompletion } from "./contracts/completion.js";
import type { QueueName } from "./contracts/queue-names.js";
import type { JobsService } from "./jobs.service.js";
import type { QueueRegistry } from "./queue.registry.js";
import type { PrismaService } from "../common/prisma/prisma.service.js";
import type { RedisService } from "../common/redis/redis.service.js";

// The job-type -> queue mapping is the identity today; a test that splits a type
// onto another queue needs to be able to say so.
vi.mock("./contracts/queue-names.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./contracts/queue-names.js")>();
  return { ...actual, queueForJobType: vi.fn(actual.queueForJobType) };
});

const NOW = new Date("2026-09-27T12:00:00.000Z");
/** media.proxy: lock 600 s, heartbeat 200 s, so silent past 600 s. */
const PROXY_SILENCE_MS = 3 * heartbeatIntervalMs("media.proxy");

const WS = "01M1KFX35NJRD5N58H0J6YGAPC";
const PROJECT = "01M2K1R52AANE4TH9RS5VH167D";
const MEDIA = "01M2AT48M2ERZ8J1AX2DS3H667";

interface Row {
  id: string;
  type: string;
  status: string;
  attemptId: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  lastEventAt: Date | null;
  params: Record<string, unknown>;
}

let rows: Row[];
let states: Map<string, string>;
let jobData: Map<string, unknown>;
let stateError: Error | null;
let getJobError: Error | null;
let complete: ReturnType<typeof vi.fn>;
let findUnique: ReturnType<typeof vi.fn>;
let findMany: ReturnType<typeof vi.fn>;
let mediaUpdates: { where: unknown; data: Record<string, unknown> }[];
let scheduler: ScheduledTasksService;
let task: LeaseReaperTask;
let queriedBullIds: string[];
let queuesAsked: string[];
let getJobCalls: number;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

function row(overrides: Partial<Row> & { id: string }): Row {
  const started = ago(PROXY_SILENCE_MS + 1_000);
  return {
    type: "media.proxy",
    status: "running",
    attemptId: `${overrides.id}A`,
    queuedAt: new Date(started.getTime() - 1_000),
    startedAt: started,
    lastEventAt: null,
    params: { mediaId: MEDIA },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(queueForJobType).mockImplementation((type: QueueName) => type);
  rows = [];
  states = new Map();
  jobData = new Map();
  stateError = null;
  getJobError = null;
  queriedBullIds = [];
  queuesAsked = [];
  getJobCalls = 0;
  mediaUpdates = [];
  complete = vi.fn(async () => ({ applied: true, jobId: "x", status: "failed" }));

  findMany = vi.fn(async ({ where, take }: { where: { status: string }; take: number }) =>
    rows
      .filter((r) => r.status === where.status)
      .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime())
      .slice(0, take)
      .map(({ id, type, attemptId, queuedAt, startedAt }) => ({
        id,
        type,
        attemptId,
        queuedAt,
        startedAt,
      })),
  );
  findUnique = vi.fn(async ({ where }: { where: { id: string } }) => {
    const found = rows.find((r) => r.id === where.id);
    return found === undefined ? null : { ...found };
  });
  const prisma = {
    job: { findMany, findUnique },
    jobEvent: {
      groupBy: vi.fn(async ({ where }: { where: { jobId: { in: string[] } } }) =>
        rows
          .filter((r) => where.jobId.in.includes(r.id) && r.lastEventAt !== null)
          .map((r) => ({ jobId: r.id, _max: { at: r.lastEventAt } })),
      ),
    },
    // What `InternalMediaController.patch` reads and writes.
    mediaAsset: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === MEDIA ? { id: MEDIA, projectId: PROJECT, project: { workspaceId: WS } } : null,
      ),
      updateMany: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        mediaUpdates.push(args);
        return { count: 1 };
      }),
      findUniqueOrThrow: vi.fn(async () => ({ status: "ready" })),
    },
  } as unknown as PrismaService;

  const queues = {
    queue: (name: string) => {
      queuesAsked.push(name);
      return {
        getJobState: async (bullId: string) => {
          queriedBullIds.push(bullId);
          if (stateError !== null) throw stateError;
          return states.get(bullId) ?? "unknown";
        },
        getJob: async (bullId: string) => {
          getJobCalls += 1;
          if (getJobError !== null) throw getJobError;
          return jobData.has(bullId) ? { data: jobData.get(bullId) } : undefined;
        },
      };
    },
  } as unknown as QueueRegistry;

  scheduler = new ScheduledTasksService(createFakeRedis() as unknown as RedisService);
  task = new LeaseReaperTask(prisma, { complete } as unknown as JobsService, queues, scheduler);
});

/** The first (in these tests, the only) settlement sent to `JobsService.complete`. */
function completionOf(): { jobId: string; attemptId: string; body: JobCompletion } {
  const [jobId, attemptId, body] = complete.mock.calls.at(0) as [string, string, JobCompletion];
  return { jobId, attemptId, body };
}

describe("registration", () => {
  it("registers itself every minute under its allowlist name", async () => {
    task.onModuleInit();
    expect(scheduler.registered).toEqual([LEASE_REAPER_TASK]);
    expect(LEASE_REAPER_TASK).toBe("jobs.lease-reaper");
    expect(LEASE_REAPER_INTERVAL_MS).toBe(60_000);

    const sweep = vi
      .spyOn(task, "sweep")
      .mockResolvedValue({ silent: 0, reaped: [], delivered: [], spared: 0 });
    await scheduler.runNow(LEASE_REAPER_TASK);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("skips a tick while the previous pass is still running, so handlers never run twice at once", async () => {
    let release: (value: never[]) => void = () => undefined;
    findMany.mockImplementationOnce(
      async () =>
        new Promise<never[]>((resolve) => {
          release = resolve;
        }),
    );

    const first = task.tick(NOW);
    await expect(task.tick(NOW)).resolves.toBeNull();
    release([]);
    await expect(first).resolves.toEqual({ silent: 0, reaped: [], delivered: [], spared: 0 });
    // Free again once the first pass is over.
    await expect(task.tick(NOW)).resolves.not.toBeNull();
  });
});

describe("lastSignalAt", () => {
  const queuedAt = ago(60 * 60_000);

  it("is the newest event when the worker reported after it started", () => {
    const event = ago(60_000);
    expect(lastSignalAt({ queuedAt, startedAt: ago(30 * 60_000), lastEventAt: event })).toBe(event);
  });

  it("is the start when the only events are older, from an attempt before a replay", () => {
    const started = ago(60_000);
    expect(lastSignalAt({ queuedAt, startedAt: started, lastEventAt: ago(50 * 60_000) })).toBe(
      started,
    );
  });

  it("falls back to the enqueue when the row never recorded a start or an event", () => {
    expect(lastSignalAt({ queuedAt, startedAt: null, lastEventAt: null })).toBe(queuedAt);
  });
});

describe("isSilent", () => {
  it("measures silence in heartbeats of the job's own queue", () => {
    expect(isSilent({ type: "media.proxy", lastSignalAt: ago(PROXY_SILENCE_MS - 1) }, NOW)).toBe(
      false,
    );
    expect(isSilent({ type: "media.proxy", lastSignalAt: ago(PROXY_SILENCE_MS + 1) }, NOW)).toBe(
      true,
    );
    // notify's lock is 30 s: silent after 30 s, where media would still be fine.
    expect(isSilent({ type: "notify", lastSignalAt: ago(31_000) }, NOW)).toBe(true);
    expect(isSilent({ type: "not.a.queue", lastSignalAt: ago(10 * PROXY_SILENCE_MS) }, NOW)).toBe(
      false,
    );
  });

  it("uses the heartbeat of the queue the type runs on, not the type's own name", () => {
    // A split that put media.proxy on notify's 30-second lock.
    vi.mocked(queueForJobType).mockImplementation((type) =>
      type === "media.proxy" ? "notify" : type,
    );
    expect(isSilent({ type: "media.proxy", lastSignalAt: ago(31_000) }, NOW)).toBe(true);
  });
});

describe("sweep: nothing to deliver", () => {
  it("fails a silent job BullMQ has lost, through JobsService, as a final stalled failure", async () => {
    rows = [row({ id: "01ZOMBIE" })];

    const report = await task.sweep(NOW);

    expect(report).toEqual({ silent: 1, reaped: ["01ZOMBIE"], delivered: [], spared: 0 });
    expect(queriedBullIds).toEqual(["01ZOMBIE-01ZOMBIEA"]);
    const { jobId, attemptId, body } = completionOf();
    expect(jobId).toBe("01ZOMBIE");
    expect(attemptId).toBe("01ZOMBIEA");
    expect(body.status).toBe("failed");
    expect(body.finalAttempt).toBe(true);
    expect(body.error).toEqual({
      code: JOB_STALLED_CODE,
      message: JOB_STALLED_MESSAGE,
      retryable: true,
      facts: {
        silentMs: PROXY_SILENCE_MS + 1_000,
        heartbeatMs: heartbeatIntervalMs("media.proxy"),
        queueState: "unknown",
      },
    });
  });

  it("words the failure for the person who sees it; the numbers stay in facts", async () => {
    rows = [row({ id: "01Z" })];

    await task.sweep(NOW);

    // The browser (realtime) and outgoing webhooks both get this message.
    const message = completionOf().body.error?.message ?? "";
    expect(message).not.toMatch(/\d/);
    expect(message).not.toMatch(/queue|worker|unknown/i);
  });

  it("fails a job BullMQ finished whose data carries nothing to deliver", async () => {
    rows = [row({ id: "01DONE" }), row({ id: "01GAVEUP" })];
    states.set("01DONE-01DONEA", "completed");
    states.set("01GAVEUP-01GAVEUPA", "failed");
    jobData.set("01GAVEUP-01GAVEUPA", { jobId: "01GAVEUP", payload: {} });

    await expect(task.sweep(NOW)).resolves.toMatchObject({
      reaped: ["01DONE", "01GAVEUP"],
      delivered: [],
    });
  });

  it.each(["active", "waiting", "delayed", "prioritized", "waiting-children"])(
    "spares a silent job BullMQ still holds %s",
    async (state) => {
      rows = [row({ id: "01QUIET" })];
      states.set("01QUIET-01QUIETA", state);

      const report = await task.sweep(NOW);

      expect(report).toEqual({ silent: 1, reaped: [], delivered: [], spared: 1 });
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("counts the newest job event as the heartbeat, without asking BullMQ", async () => {
    // Started long ago, but reported progress a minute ago.
    rows = [row({ id: "01ALIVE", startedAt: ago(3 * 60 * 60_000), lastEventAt: ago(60_000) })];

    await expect(task.sweep(NOW)).resolves.toEqual({
      silent: 0,
      reaped: [],
      delivered: [],
      spared: 0,
    });
    expect(queriedBullIds).toEqual([]);
  });

  it("spares everything when Redis cannot say what state the job is in", async () => {
    rows = [row({ id: "01Z" })];
    stateError = new Error("connect ECONNREFUSED");

    await expect(task.sweep(NOW)).resolves.toEqual({
      silent: 1,
      reaped: [],
      delivered: [],
      spared: 1,
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it("asks the queue the job type runs on, which is not always the type's own name", async () => {
    vi.mocked(queueForJobType).mockImplementation((type) =>
      type === "media.proxy" ? "media.clip" : type,
    );
    rows = [row({ id: "01SPLIT" })];
    states.set("01SPLIT-01SPLITA", "active");

    await expect(task.sweep(NOW)).resolves.toMatchObject({ spared: 1, reaped: [] });
    expect(queuesAsked).toEqual(["media.clip"]);
  });

  it("re-reads the row and leaves one that settled, or got a new attempt, since the scan", async () => {
    rows = [row({ id: "01SETTLED" }), row({ id: "01REPLAYED" })];
    findUnique.mockImplementationOnce(async () => ({ ...rows[0], status: "failed" }));
    findUnique.mockImplementationOnce(async () => ({ ...rows[1], attemptId: "01NEWATTEMPT" }));

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: [], delivered: [] });
    expect(complete).not.toHaveBeenCalled();
  });

  it("counts only settlements the conditional update won", async () => {
    rows = [row({ id: "01RACE" })];
    complete.mockResolvedValueOnce({ applied: false, jobId: "01RACE", status: "succeeded" });

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: [] });
  });

  it("keeps going when a failure handler throws, and leaves that job for the next pass", async () => {
    rows = [row({ id: "01A" }), row({ id: "01B" })];
    complete.mockRejectedValueOnce(new Error("handler down"));

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: ["01B"] });
  });

  it("uses the job id for a legacy row without an attempt", async () => {
    rows = [row({ id: "01LEGACY", attemptId: null })];

    await task.sweep(NOW);

    expect(queriedBullIds).toEqual(["01LEGACY-01LEGACY"]);
    expect(completionOf().attemptId).toBe("01LEGACY");
  });

  it("settles at most one batch a pass", async () => {
    rows = Array.from({ length: LEASE_REAPER_BATCH + 5 }, (_, index) =>
      row({ id: `01J${String(index).padStart(3, "0")}` }),
    );

    const report = await task.sweep(NOW);

    expect(report.reaped).toHaveLength(LEASE_REAPER_BATCH);
  });
});

describe("sweep: an outcome the worker produced but never delivered", () => {
  const failed = {
    status: "failed",
    error: {
      code: "media/source_blocked",
      message: "YouTube refused the download",
      retryable: false,
    },
    finalAttempt: true,
  } as const;

  function carry(id: string, pendingOutcome: unknown, state = "failed"): void {
    states.set(`${id}-${id}A`, state);
    jobData.set(`${id}-${id}A`, { jobId: id, attemptId: `${id}A`, payload: {}, pendingOutcome });
  }

  it("delivers a carried failure with its own code instead of jobs/stalled", async () => {
    rows = [row({ id: "01ACQ", type: "media.acquire", params: {} })];
    carry("01ACQ", { attemptId: "01ACQA", completion: failed });

    const report = await task.sweep(NOW);

    expect(report).toMatchObject({ reaped: [], delivered: ["01ACQ"] });
    expect(completionOf()).toEqual({ jobId: "01ACQ", attemptId: "01ACQA", body: failed });
  });

  it("delivers a carried success with its media write-back first, so a finished proxy stays finished", async () => {
    const proxyKey = `ws/${WS}/p/${PROJECT}/media/${MEDIA}/proxy.mp4`;
    rows = [row({ id: "01PROXY" })];
    carry("01PROXY", {
      attemptId: "01PROXYA",
      mediaPatch: { status: "ready", proxyKey },
      completion: { status: "succeeded", result: { proxyKey } },
    });

    const report = await task.sweep(NOW);

    expect(report).toMatchObject({ reaped: [], delivered: ["01PROXY"] });
    expect(mediaUpdates).toEqual([{ where: { id: MEDIA }, data: { status: "ready", proxyKey } }]);
    expect(completionOf().body).toEqual({ status: "succeeded", result: { proxyKey } });
  });

  it("fails a carried success as stalled when its write-back would point outside the asset", async () => {
    rows = [row({ id: "01EVIL" })];
    carry("01EVIL", {
      attemptId: "01EVILA",
      mediaPatch: { status: "ready", proxyKey: `ws/${WS}/p/${PROJECT}/media/01OTHER/proxy.mp4` },
      completion: { status: "succeeded" },
    });

    const report = await task.sweep(NOW);

    expect(report).toMatchObject({ reaped: ["01EVIL"], delivered: [] });
    expect(mediaUpdates).toEqual([]);
    expect(completionOf().body.error?.code).toBe(JOB_STALLED_CODE);
  });

  it("fails a carried success as stalled when its write-back is not one the API accepts", async () => {
    rows = [row({ id: "01ODD" })];
    carry("01ODD", {
      attemptId: "01ODDA",
      mediaPatch: { storageKey: "somewhere/else" },
      completion: { status: "succeeded" },
    });

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: ["01ODD"] });
    expect(mediaUpdates).toEqual([]);
  });

  it("still delivers a carried failure when its write-back cannot be applied, as the worker would", async () => {
    rows = [row({ id: "01GONE", params: { mediaId: "01M2AT48M2ERZ8J1AX2DS3H668" } })];
    carry("01GONE", {
      attemptId: "01GONEA",
      mediaPatch: { status: "failed", failureReason: "media/probe_failed" },
      completion: failed,
    });

    await expect(task.sweep(NOW)).resolves.toMatchObject({ delivered: ["01GONE"] });
    expect(completionOf().body).toEqual(failed);
  });

  it("never delivers an outcome carried for another attempt", async () => {
    rows = [row({ id: "01OLD" })];
    carry("01OLD", { attemptId: "01PREVIOUSATTEMPT", completion: failed });

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: ["01OLD"], delivered: [] });
    expect(completionOf().body.error?.code).toBe(JOB_STALLED_CODE);
  });

  it("ignores a carried outcome that does not parse", async () => {
    rows = [row({ id: "01JUNK" })];
    carry("01JUNK", { attemptId: "01JUNKA", completion: { status: "maybe" } });

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: ["01JUNK"] });
  });

  it("fails the job as stalled when its data cannot be read", async () => {
    rows = [row({ id: "01NODATA" })];
    carry("01NODATA", { attemptId: "01NODATAA", completion: failed });
    getJobError = new Error("connection reset");

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: ["01NODATA"] });
  });

  it("only looks for a carried outcome once BullMQ has finished with the job", async () => {
    rows = [row({ id: "01LOST" })];
    // Not in Redis at all ("unknown"): nothing to read, and no reason to try.

    await expect(task.sweep(NOW)).resolves.toMatchObject({ reaped: ["01LOST"] });
    expect(getJobCalls).toBe(0);
  });
});
