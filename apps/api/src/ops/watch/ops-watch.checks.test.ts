import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSUMED_LOOKBACK_MS,
  DISK_MIN_FREE_BYTES,
  EVENT_LOOKBACK_MS,
  OpsWatchChecks,
  QUEUED_TOO_LONG_MS,
  SCAN_LIMIT,
  clientNames,
  countWorkers,
} from "./ops-watch.checks.js";
import { queueForJobType } from "../../jobs/contracts/queue-names.js";
import {
  ACQUIRE_RUNNING_MARGIN_MS,
  STAGE_RUNNING_BASE_MS,
} from "../../repurpose/repurpose.constants.js";

import type { DiskProbe } from "./ops-watch.checks.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { RedisService } from "../../common/redis/redis.service.js";
import type { QueueName } from "../../jobs/contracts/queue-names.js";
import type { QueueRegistry } from "../../jobs/queue.registry.js";

// Identity today; the tests that put two job types on one queue need to say so.
vi.mock("../../jobs/contracts/queue-names.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../jobs/contracts/queue-names.js")>();
  return { ...actual, queueForJobType: vi.fn(actual.queueForJobType) };
});

const NOW = new Date("2026-09-27T12:00:00.000Z");
const MIN = 60_000;
const GIB = 1024 ** 3;

const b64 = (queue: string) => Buffer.from(queue).toString("base64");

/** One row of the fake `jobs` table. */
interface JobRow {
  id: string;
  type: string;
  status: string;
  queuedAt: Date;
  startedAt?: Date | null;
  projectId?: string | null;
  params?: Record<string, unknown>;
}

interface Where {
  status?: string | { in: string[] };
  type?: string;
  queuedAt?: { lt?: Date; gt?: Date };
  OR?: Where[];
}

/** The subset of Prisma's `where` the checks use, evaluated for real. */
function matches(row: JobRow, where: Where): boolean {
  if (where.OR !== undefined && !where.OR.some((branch) => matches(row, branch))) return false;
  if (typeof where.status === "string" && row.status !== where.status) return false;
  if (typeof where.status === "object" && !where.status.in.includes(row.status)) return false;
  if (where.type !== undefined && row.type !== where.type) return false;
  if (where.queuedAt?.lt !== undefined && !(row.queuedAt < where.queuedAt.lt)) return false;
  if (where.queuedAt?.gt !== undefined && !(row.queuedAt > where.queuedAt.gt)) return false;
  return true;
}

function byQueuedAt(a: JobRow, b: JobRow): number {
  return a.queuedAt.getTime() - b.queuedAt.getTime();
}

let jobs: JobRow[];
let media: { id: string; projectId: string; durationMs: number | null }[];
let dlqFindMany: ReturnType<typeof vi.fn>;
let runFindMany: ReturnType<typeof vi.fn>;
let clientList: string;
let listCalls: number;
let disk: { bsize: number; blocks: number; bavail: number };
let checks: OpsWatchChecks;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

beforeEach(() => {
  vi.mocked(queueForJobType).mockImplementation((type: QueueName) => type);
  jobs = [];
  media = [];
  dlqFindMany = vi.fn(async () => []);
  runFindMany = vi.fn(async () => []);
  clientList = "";
  listCalls = 0;
  disk = { bsize: 4096, blocks: (500 * GIB) / 4096, bavail: (200 * GIB) / 4096 };

  const prisma = {
    job: {
      findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) =>
        jobs
          .filter((row) => matches(row, where))
          .sort(byQueuedAt)
          .slice(0, take)
          .map((row) => ({
            id: row.id,
            type: row.type,
            projectId: row.projectId ?? null,
            params: row.params ?? {},
            queuedAt: row.queuedAt,
            startedAt: row.startedAt ?? null,
          })),
      ),
      findFirst: vi.fn(async ({ where }: { where: Where }) => {
        const first = jobs.filter((row) => matches(row, where)).sort(byQueuedAt)[0];
        return first === undefined ? null : { id: first.id, queuedAt: first.queuedAt };
      }),
      groupBy: vi.fn(async ({ by, where }: { by: ("type" | "status")[]; where: Where }) => {
        const withStatus = by.includes("status");
        const groups = new Map<string, { type: string; status?: string; count: number }>();
        for (const row of jobs.filter((candidate) => matches(candidate, where))) {
          const key = withStatus ? `${row.type}|${row.status}` : row.type;
          const group = groups.get(key);
          if (group !== undefined) group.count += 1;
          else if (withStatus) groups.set(key, { type: row.type, status: row.status, count: 1 });
          else groups.set(key, { type: row.type, count: 1 });
        }
        return [...groups.values()].map(({ count, ...keys }) => ({
          ...keys,
          _count: { _all: count },
        }));
      }),
    },
    mediaAsset: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        media
          .filter((asset) => where.id.in.includes(asset.id))
          .map(({ id, durationMs }) => ({ id, durationMs })),
      ),
      groupBy: vi.fn(async ({ where }: { where: { projectId: { in: string[] } } }) => {
        const max = new Map<string, number | null>();
        for (const asset of media.filter((a) => where.projectId.in.includes(a.projectId))) {
          const seen = max.get(asset.projectId) ?? null;
          const next =
            asset.durationMs === null ? seen : Math.max(seen ?? -Infinity, asset.durationMs);
          max.set(asset.projectId, next);
        }
        return [...max].map(([projectId, durationMs]) => ({
          projectId,
          _max: { durationMs },
        }));
      }),
    },
    dlqEntry: { findMany: dlqFindMany },
    repurposeRun: { findMany: runFindMany },
  } as unknown as PrismaService;
  const redis = {
    client: {
      client: vi.fn(async (subcommand: string) => {
        expect(subcommand).toBe("LIST");
        listCalls += 1;
        return clientList;
      }),
    },
  } as unknown as RedisService;
  const probe: DiskProbe = {
    path: "C:\\Users\\someone\\montaj-release\\apps\\api",
    statfs: async () => disk,
  };
  checks = new OpsWatchChecks(prisma, redis, { prefix: "bull" } as unknown as QueueRegistry, probe);
});

function running(id: string, type: string, sinceMs: number, extra: Partial<JobRow> = {}): JobRow {
  return {
    id,
    type,
    status: "running",
    queuedAt: ago(sinceMs + MIN),
    startedAt: ago(sinceMs),
    ...extra,
  };
}

describe("jobs.over-ceiling", () => {
  it("uses the reconciler's ceilings: a download's deadline per attempt + back-off + 10 min, other work 60 min + 2x the video", async () => {
    media = [{ id: "01M20", projectId: "01P", durationMs: 20 * MIN }];
    jobs = [
      // 40 min deadline, two attempts a minute apart -> ceiling 91 min; 92 min in.
      running("01ACQ", "media.acquire", 92 * MIN, { params: { limits: { timeoutMs: 40 * MIN } } }),
      // Same deadline, 90 min in: fine.
      running("01ACQOK", "media.acquire", 90 * MIN, {
        params: { limits: { timeoutMs: 40 * MIN } },
      }),
      // 20-min video (its media asset) -> ceiling 100 min; 101 min in.
      running("01TR", "ai.transcribe", 101 * MIN, { params: { mediaId: "01M20" } }),
      // 20-min video (its payload), 99 min in: fine.
      running("01TROK", "ai.transcribe", 99 * MIN, { params: { durationMs: 20 * MIN } }),
      // No duration known: the base hour.
      running("01RV", "render.video", STAGE_RUNNING_BASE_MS + MIN),
      // Not running: never looked at.
      { id: "01Q", type: "render.video", status: "queued", queuedAt: ago(10 * 60 * MIN) },
    ];

    const { findings, partial } = await checks.jobsOverCeiling(NOW);

    expect(partial).toBe(false);
    expect(findings).toEqual([
      {
        check: "jobs.over-ceiling",
        subject: "ai.transcribe",
        severity: "warning",
        line: "ai.transcribe: 1 job past the ceiling; 01TR running 1 h 41 min (ceiling 1 h 40 min)",
      },
      {
        check: "jobs.over-ceiling",
        subject: "media.acquire",
        severity: "warning",
        line: "media.acquire: 1 job past the ceiling; 01ACQ running 1 h 32 min (ceiling 1 h 31 min)",
      },
      {
        check: "jobs.over-ceiling",
        subject: "render.video",
        severity: "warning",
        line: "render.video: 1 job past the ceiling; 01RV running 1 h 1 min (ceiling 1 h)",
      },
    ]);
    expect(ACQUIRE_RUNNING_MARGIN_MS).toBe(10 * MIN);
  });

  it("takes the video length from the payload first, then the media asset, then the project's longest", async () => {
    media = [
      { id: "01M120", projectId: "01P", durationMs: 120 * MIN },
      { id: "01MNULL", projectId: "01P2", durationMs: null },
      { id: "01M240", projectId: "01P2", durationMs: 240 * MIN },
    ];
    jobs = [
      // Payload says 10 min (-> 80 min ceiling); the asset's 120 would allow 300.
      running("01PAYLOAD", "ai.transcribe", 81 * MIN, {
        projectId: "01P",
        params: { durationMs: 10 * MIN, sourceDurationMs: 60 * MIN, mediaId: "01M120" },
      }),
      // The window's source length when the payload has no duration of its own.
      running("01SOURCE", "ai.transcribe", 181 * MIN, {
        params: { sourceDurationMs: 60 * MIN, mediaId: "01M120" },
      }),
      // Its own asset has no length yet: the project's longest (240 -> 540 min).
      running("01PROJECT", "media.proxy", 539 * MIN, {
        projectId: "01P2",
        params: { mediaId: "01MNULL" },
      }),
    ];

    const { findings } = await checks.jobsOverCeiling(NOW);

    expect(findings.map((finding) => finding.line)).toEqual([
      "ai.transcribe: 2 jobs past the ceiling; 01SOURCE running 3 h 1 min (ceiling 3 h), 01PAYLOAD running 1 h 21 min (ceiling 1 h 20 min)",
    ]);
  });

  it("reports one line per queue, naming the longest three and counting the rest", async () => {
    jobs = Array.from({ length: 5 }, (_, index) =>
      running(`01R${String(index)}`, "render.video", STAGE_RUNNING_BASE_MS + (index + 1) * MIN),
    );

    const { findings } = await checks.jobsOverCeiling(NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(
      "render.video: 5 jobs past the ceiling; 01R4 running 1 h 5 min (ceiling 1 h), " +
        "01R3 running 1 h 4 min (ceiling 1 h), 01R2 running 1 h 3 min (ceiling 1 h), and 2 more",
    );
  });

  it("says it saw only part when the scan hit its cap, so nothing past it is called cleared", async () => {
    jobs = Array.from({ length: SCAN_LIMIT }, (_, index) =>
      running(`01J${String(index).padStart(4, "0")}`, "render.video", MIN),
    );

    await expect(checks.jobsOverCeiling(NOW)).resolves.toMatchObject({ partial: true });
  });

  it("files a job under the queue its type runs on", async () => {
    vi.mocked(queueForJobType).mockImplementation((type) =>
      type === "render.subtitle" ? "render.video" : type,
    );
    jobs = [
      running("01V", "render.video", STAGE_RUNNING_BASE_MS + MIN),
      running("01S", "render.subtitle", STAGE_RUNNING_BASE_MS + 2 * MIN),
    ];

    const { findings } = await checks.jobsOverCeiling(NOW);

    expect(findings.map((finding) => finding.subject)).toEqual(["render.video"]);
    expect(findings[0]?.line).toMatch(/^render\.video: 2 jobs past the ceiling/);
  });
});

describe("jobs.queued-too-long", () => {
  it("reports each queue with jobs still queued 15 minutes on: how many, and the oldest", async () => {
    jobs = [
      { id: "01Q1", type: "media.acquire", status: "queued", queuedAt: ago(42 * MIN) },
      { id: "01Q2", type: "media.acquire", status: "queued", queuedAt: ago(17 * MIN) },
      // Not yet 15 minutes: not counted.
      {
        id: "01Q3",
        type: "media.acquire",
        status: "queued",
        queuedAt: ago(QUEUED_TOO_LONG_MS - 1),
      },
      { id: "01F1", type: "ai.faces", status: "queued", queuedAt: ago(20 * MIN) },
      // Running, however old: not this check's business.
      { id: "01R", type: "ai.faces", status: "running", queuedAt: ago(90 * MIN) },
    ];

    const findings = await checks.jobsQueuedTooLong(NOW);

    expect(findings).toEqual([
      {
        check: "jobs.queued-too-long",
        subject: "ai.faces",
        severity: "warning",
        line: "ai.faces: 1 job queued over 15 min, oldest 20 min (01F1)",
      },
      {
        check: "jobs.queued-too-long",
        subject: "media.acquire",
        severity: "warning",
        line: "media.acquire: 2 jobs queued over 15 min, oldest 42 min (01Q1)",
      },
    ]);
  });

  it("puts types that share a queue on one line, with the oldest of all of them", async () => {
    vi.mocked(queueForJobType).mockImplementation((type) =>
      type === "ai.align" ? "ai.transcribe" : type,
    );
    jobs = [
      { id: "01T", type: "ai.transcribe", status: "queued", queuedAt: ago(20 * MIN) },
      { id: "01A", type: "ai.align", status: "queued", queuedAt: ago(30 * MIN) },
    ];

    await expect(checks.jobsQueuedTooLong(NOW)).resolves.toMatchObject([
      {
        subject: "ai.transcribe",
        line: "ai.transcribe: 2 jobs queued over 15 min, oldest 30 min (01A)",
      },
    ]);
  });
});

describe("dlq.new", () => {
  it("reports recent dead letters by id, queue and error code, never the message", async () => {
    dlqFindMany.mockResolvedValueOnce([
      {
        id: "01D",
        queue: "media.acquire",
        jobId: "01J",
        lastError: {
          code: "media/source_blocked",
          message: "https://youtube.com/watch?v=secret said no",
        },
      },
      {
        id: "01E",
        queue: "ai.transcribe",
        jobId: "01K",
        lastError: { code: "Sign in, then https://x", message: "" },
      },
      { id: "01F", queue: "media.proxy", jobId: "01L", lastError: null },
    ]);

    const findings = await checks.newDeadLetters(NOW);

    const where = (dlqFindMany.mock.calls[0]?.[0] as { where: { failedAt: { gte: Date } } }).where;
    expect(where.failedAt.gte).toEqual(ago(EVENT_LOOKBACK_MS));
    expect(findings.map((finding) => finding.line)).toEqual([
      "media.acquire job 01J: media/source_blocked",
      "ai.transcribe job 01K: no error code",
      "media.proxy job 01L: no error code",
    ]);
    expect(findings.every((finding) => finding.check === "dlq.new")).toBe(true);
  });
});

describe("queues.no-worker", () => {
  function recent(id: string, type: string, status: string): JobRow {
    return { id, type, status, queuedAt: ago(60 * MIN) };
  }

  it("flags a queue the product uses with no worker in either client-name dialect", async () => {
    jobs = [
      recent("1", "media.probe", "queued"),
      recent("2", "media.probe", "queued"),
      recent("3", "media.probe", "running"),
      recent("4", "media.probe", "succeeded"),
      recent("5", "media.proxy", "succeeded"),
      recent("6", "ai.transcribe", "queued"),
      recent("7", "media.acquire", "failed"),
      recent("8", "legacy.thing", "queued"),
      // Used long ago and finished: not a queue this deployment still consumes.
      {
        id: "9",
        type: "publish.dispatch",
        status: "succeeded",
        queuedAt: ago(CONSUMED_LOOKBACK_MS + MIN),
      },
    ];
    clientList = [
      // worker-media (Node): base64 queue names, one of them a named worker.
      `id=1 addr=127.0.0.1:5000 name=bull:${b64("media.proxy")} db=0 cmd=bzpopmin`,
      `id=2 addr=127.0.0.1:5001 name=bull:${b64("media.acquire")}:w:acquire db=0 cmd=bzpopmin`,
      // worker-ai (Python): plain queue names.
      "id=3 addr=127.0.0.1:5002 name=bull:ai.transcribe db=0 cmd=bzpopmin",
      // The API's own producer and scheduler connections.
      `id=4 addr=127.0.0.1:5003 name= db=0 cmd=client|list`,
      `id=5 addr=127.0.0.1:5004 name=bull:${b64("scheduler")} db=0 cmd=bzpopmin`,
    ].join("\n");

    const findings = await checks.queuesWithoutWorkers(NOW);

    expect(findings).toEqual([
      {
        check: "queues.no-worker",
        subject: "media.probe",
        severity: "critical",
        line: "media.probe: no worker connected, 3 open jobs waiting",
      },
    ]);
  });

  it("is a warning, not critical, while nothing is waiting on the queue", async () => {
    jobs = [recent("1", "media.probe", "succeeded")];

    const findings = await checks.queuesWithoutWorkers(NOW);

    expect(findings).toEqual([
      {
        check: "queues.no-worker",
        subject: "media.probe",
        severity: "warning",
        line: "media.probe: no worker connected",
      },
    ]);
  });

  it("looks for workers on the queue a type runs on, and counts its jobs there", async () => {
    vi.mocked(queueForJobType).mockImplementation((type) =>
      type === "ai.align" ? "ai.transcribe" : type,
    );
    jobs = [recent("1", "ai.align", "queued"), recent("2", "ai.transcribe", "queued")];
    // A worker on ai.align's own name would be listening to a queue nothing is sent to.
    clientList = "id=1 name=bull:ai.align db=0";

    await expect(checks.queuesWithoutWorkers(NOW)).resolves.toEqual([
      {
        check: "queues.no-worker",
        subject: "ai.transcribe",
        severity: "critical",
        line: "ai.transcribe: no worker connected, 2 open jobs waiting",
      },
    ]);
  });

  it("does not ask Redis when the product has used no queue at all", async () => {
    jobs = [recent("1", "not.a.queue", "queued")];
    await expect(checks.queuesWithoutWorkers(NOW)).resolves.toEqual([]);
    expect(listCalls).toBe(0);
  });
});

describe("clientNames / countWorkers", () => {
  it("counts only the worker connections of that exact queue under that prefix", () => {
    const names = clientNames(
      [
        `id=1 name=bull:${b64("media.clip")}`,
        `id=2 name=bull:${b64("media.clip")}:w:one`,
        "id=3 name=bull:media.clip:w:py",
        `id=4 name=other:${b64("media.clip")}`,
        `id=5 name=bull:${b64("media.clip")}x`,
        "id=6 name=bull:media.clipper",
        "id=7 name=",
      ].join("\r\n"),
    );
    expect(countWorkers(names, "bull", "media.clip")).toBe(3);
  });
});

describe("disk.low", () => {
  it("is quiet with room to spare", async () => {
    await expect(checks.diskLow()).resolves.toEqual([]);
  });

  it("warns under 15% free and names only the volume", async () => {
    disk = { ...disk, bavail: (60 * GIB) / 4096 };

    const [finding] = await checks.diskLow();

    expect(finding).toEqual({
      check: "disk.low",
      subject: "C:\\",
      severity: "warning",
      line: "C:\\ 60.0 GiB free of 500.0 GiB (12.0%)",
    });
    expect(finding?.line).not.toContain("someone");
  });

  it("is critical under 5 GiB, whatever the percentage", async () => {
    disk = { bsize: 4096, blocks: (20 * GIB) / 4096, bavail: (DISK_MIN_FREE_BYTES - GIB) / 4096 };

    await expect(checks.diskLow()).resolves.toMatchObject([
      { severity: "critical", line: "C:\\ 4.0 GiB free of 20.0 GiB (20.0%)" },
    ]);
  });
});

describe("repurpose.run-failed", () => {
  it("reports recently failed runs by id and failure code, keyed on both", async () => {
    runFindMany.mockResolvedValueOnce([
      { id: "01R", failureCode: "repurpose/source_blocked" },
      { id: "01S", failureCode: null },
    ]);

    const findings = await checks.failedRuns(NOW);

    const where = (
      runFindMany.mock.calls[0]?.[0] as { where: { status: string; updatedAt: { gte: Date } } }
    ).where;
    expect(where).toEqual({ status: "failed", updatedAt: { gte: ago(EVENT_LOOKBACK_MS) } });
    expect(findings).toEqual([
      {
        check: "repurpose.run-failed",
        subject: "01R:repurpose/source_blocked",
        severity: "info",
        line: "run 01R: repurpose/source_blocked",
      },
      {
        check: "repurpose.run-failed",
        subject: "01S:no error code",
        severity: "info",
        line: "run 01S: no error code",
      },
    ]);
  });
});

describe("all", () => {
  it("runs the six checks, each answering with its findings and whether it saw everything", async () => {
    const all = checks.all();
    expect(all.map((check) => check.id)).toEqual([
      "disk.low",
      "queues.no-worker",
      "jobs.over-ceiling",
      "jobs.queued-too-long",
      "dlq.new",
      "repurpose.run-failed",
    ]);
    for (const check of all) {
      await expect(check.run(NOW)).resolves.toEqual({ findings: [], partial: false });
    }
  });
});
