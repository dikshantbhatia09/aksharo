import { describe, expect, it, vi } from "vitest";

import { STATUS_PUBLISH_TASK, StatusPublishTask } from "./status-publish.task.js";

import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import type { HealthService } from "../../health/health.service.js";
import type { OpsIncidentsService } from "../../ops/ops-incidents.service.js";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function harness(opts: {
  db?: "up" | "down";
  redis?: "up" | "down";
  storage?: "up" | "down";
  queueBacklog?: number;
  workerFailed?: number;
  workerSucceeded?: number;
  renderFailed?: number;
  renderSucceeded?: number;
  openIncidents?: {
    id: string;
    title: string;
    body: string;
    component: string;
    severity: "minor" | "major" | "critical";
    status: "investigating" | "monitoring" | "resolved";
    startedAt: Date;
    resolvedAt: Date | null;
  }[];
}) {
  const readiness = vi.fn(async () => ({
    status:
      opts.db === "down" || opts.redis === "down" || opts.storage === "down" ? "degraded" : "ok",
    checks: {
      db: { status: opts.db ?? "up", latencyMs: 3 },
      redis: { status: opts.redis ?? "up", latencyMs: 1 },
      storage: { status: opts.storage ?? "up", latencyMs: 12 },
    },
  }));
  const health = { readiness } as unknown as HealthService;

  const openForStatusPage = vi.fn(async () => opts.openIncidents ?? []);
  const incidents = { openForStatusPage } as unknown as OpsIncidentsService;

  const count = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const where = args.where;
    if (where["status"] === "queued") return opts.queueBacklog ?? 0;
    const types = (where["type"] as { in: string[] }).in;
    if (types.includes("render")) {
      return where["status"] === "failed" ? (opts.renderFailed ?? 0) : (opts.renderSucceeded ?? 0);
    }
    return where["status"] === "failed" ? (opts.workerFailed ?? 0) : (opts.workerSucceeded ?? 0);
  });
  const create = vi.fn(async () => undefined);
  const prisma = {
    job: { count },
    opsStatusSnapshot: { create },
  } as unknown as PrismaService;

  const scheduler = { register: vi.fn() };
  const task = new StatusPublishTask(
    prisma,
    health,
    incidents,
    scheduler as unknown as ScheduledTasksService,
  );
  return { task, prisma, create, scheduler };
}

describe("registration", () => {
  it("registers a 5-minute cron", () => {
    const { task, scheduler } = harness({});
    task.onModuleInit();
    const registered = scheduler.register.mock.calls[0]?.[0] as { name: string; cron?: string };
    expect(registered.name).toBe(STATUS_PUBLISH_TASK);
    expect(registered.cron).toBeTypeOf("string");
  });
});

describe("build", () => {
  it("is all-operational when every dependency and lane is healthy", async () => {
    const { task } = harness({});
    const snapshot = await task.build(NOW);
    expect(snapshot.overall).toBe("operational");
    expect(snapshot.components.map((c) => c.status)).toEqual([
      "operational",
      "operational",
      "operational",
      "operational",
      "operational",
    ]);
    expect(snapshot.incidents).toEqual([]);
  });

  it("marks api down when the database check fails", async () => {
    const { task } = harness({ db: "down" });
    const snapshot = await task.build(NOW);
    const api = snapshot.components.find((c) => c.id === "api");
    expect(api?.status).toBe("down");
    expect(snapshot.overall).toBe("down");
  });

  it("marks queue degraded when a job has been stuck queued", async () => {
    const { task } = harness({ queueBacklog: 3 });
    const snapshot = await task.build(NOW);
    expect(snapshot.components.find((c) => c.id === "queue")?.status).toBe("degraded");
    expect(snapshot.overall).toBe("degraded");
  });

  it("marks render degraded at a 20%+ recent failure rate", async () => {
    const { task } = harness({ renderFailed: 3, renderSucceeded: 7 });
    const snapshot = await task.build(NOW);
    expect(snapshot.components.find((c) => c.id === "render")?.status).toBe("degraded");
  });

  it("stays operational under the failure threshold", async () => {
    const { task } = harness({ workerFailed: 1, workerSucceeded: 19 });
    const snapshot = await task.build(NOW);
    expect(snapshot.components.find((c) => c.id === "worker")?.status).toBe("operational");
  });

  it("embeds open incidents and their severity pulls overall status down", async () => {
    const { task } = harness({
      openIncidents: [
        {
          id: "01ABC",
          title: "Render lane slow",
          body: "Investigating a render backlog.",
          component: "render",
          severity: "major",
          status: "investigating",
          startedAt: new Date("2026-09-10T11:00:00.000Z"),
          resolvedAt: null,
        },
      ],
    });
    const snapshot = await task.build(NOW);
    expect(snapshot.incidents).toHaveLength(1);
    expect(snapshot.incidents[0]?.startedAt).toBe("2026-09-10T11:00:00.000Z");
    expect(snapshot.overall).toBe("degraded");
  });
});

describe("publish", () => {
  it("writes one ops_status_snapshots row carrying the whole payload", async () => {
    const { task, create } = harness({});
    const snapshot = await task.build(NOW);
    await task.publish(snapshot);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payload: snapshot }) }),
    );
  });
});
