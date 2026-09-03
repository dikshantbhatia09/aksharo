import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { ulid } from "ulid";

import { PrismaService } from "../../common/prisma/prisma.service.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { HealthService } from "../../health/health.service.js";
import { OpsIncidentsService, toStatusIncident } from "../../ops/ops-incidents.service.js";
import {
  worstStatus,
  type StatusComponent,
  type StatusComponentStatus,
  type StatusSnapshotPayload,
} from "../../ops/status-snapshot.js";

export const STATUS_PUBLISH_TASK = "scheduler.status-publish";

/** Every 5 minutes — frequent enough that the public page never reads a stale hour. */
const STATUS_PUBLISH_CRON = "*/5 * * * *";

/** A queued job older than this is a backlog, not just in-flight work. */
const QUEUE_BACKLOG_MS = 15 * 60 * 1000;

/** A failure rate at or above this, over the trailing window, marks a lane degraded. */
const DEGRADED_FAILURE_RATE = 0.2;

/** How far back "recent" job outcomes are read from. */
const RECENT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Publishes the public `status.json` (X04 §1: "status page reading a
 * status.json published by a B16 scheduler task").
 *
 * Every tick computes a fresh snapshot from data the API already has —
 * {@link HealthService}'s db/redis/storage probes for the `api` and `storage`
 * components, `jobs` table backlog/failure-rate for `queue`, `worker` and
 * `render` — merges in open {@link OpsIncidentsService} rows, and writes one
 * `ops_status_snapshots` row. The public controller only ever reads the
 * latest row: nothing recomputes on the read path, so a slow admin query never
 * shows up as public-page latency.
 */
@Injectable()
export class StatusPublishTask implements OnModuleInit {
  private readonly logger = new Logger(StatusPublishTask.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly health: HealthService,
    private readonly incidents: OpsIncidentsService,
    private readonly scheduler: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: STATUS_PUBLISH_TASK,
      cron: STATUS_PUBLISH_CRON,
      run: async ({ at }) => {
        const snapshot = await this.build(at);
        await this.publish(snapshot);
        this.logger.log({ overall: snapshot.overall }, "status snapshot published");
      },
    });
  }

  async build(now: Date = new Date()): Promise<StatusSnapshotPayload> {
    const [readiness, queue, worker, render, openIncidents] = await Promise.all([
      this.health.readiness(),
      this.queueComponent(now),
      this.laneComponent("worker", now, WORKER_QUEUES),
      this.laneComponent("render", now, ["render"]),
      this.incidents.openForStatusPage(now),
    ]);

    const api: StatusComponent = {
      id: "api",
      label: "API",
      status: readiness.checks.db.status === "up" ? "operational" : "down",
      detail: `db ${String(readiness.checks.db.latencyMs)}ms, redis ${String(readiness.checks.redis.latencyMs)}ms`,
    };
    const storage: StatusComponent = {
      id: "storage",
      label: "Storage",
      status: readiness.checks.storage.status === "up" ? "operational" : "degraded",
    };

    const components = [api, storage, queue, worker, render];
    const incidents = openIncidents.map(toStatusIncident);
    const overall = worstStatus([
      ...components.map((c) => c.status),
      ...(incidents.some((i) => i.status !== "resolved" && i.severity === "critical")
        ? (["down"] as const)
        : []),
      ...(incidents.some((i) => i.status !== "resolved" && i.severity === "major")
        ? (["degraded"] as const)
        : []),
    ]);

    return { generatedAt: now.toISOString(), overall, components, incidents };
  }

  async publish(snapshot: StatusSnapshotPayload): Promise<void> {
    await this.prisma.opsStatusSnapshot.create({
      data: { id: ulid(), publishedAt: new Date(snapshot.generatedAt), payload: snapshot },
    });
  }

  /** `queue`: is anything sitting `queued` longer than {@link QUEUE_BACKLOG_MS}? */
  private async queueComponent(now: Date): Promise<StatusComponent> {
    const backlog = await this.prisma.job.count({
      where: { status: "queued", queuedAt: { lt: new Date(now.getTime() - QUEUE_BACKLOG_MS) } },
    });
    const status: StatusComponentStatus = backlog > 0 ? "degraded" : "operational";
    return { id: "queue", label: "Job queue", status, detail: `${String(backlog)} stuck queued` };
  }

  /** `worker`/`render`: failure rate of recently finished jobs in the given queue types. */
  private async laneComponent(
    id: "worker" | "render",
    now: Date,
    types: readonly string[],
  ): Promise<StatusComponent> {
    const since = new Date(now.getTime() - RECENT_WINDOW_MS);
    const [failed, succeeded] = await Promise.all([
      this.prisma.job.count({
        where: { type: { in: [...types] }, status: "failed", finishedAt: { gte: since } },
      }),
      this.prisma.job.count({
        where: { type: { in: [...types] }, status: "succeeded", finishedAt: { gte: since } },
      }),
    ]);
    const total = failed + succeeded;
    const rate = total === 0 ? 0 : failed / total;
    const status: StatusComponentStatus =
      rate >= DEGRADED_FAILURE_RATE ? "degraded" : "operational";
    return {
      id,
      label: id === "worker" ? "AI worker" : "Render service",
      status,
      detail: total === 0 ? "no recent jobs" : `${String(failed)}/${String(total)} failed`,
    };
  }
}

/** Every queue A09/A10's AI worker owns (CONTRACTS §3), minus `render` (its own component). */
const WORKER_QUEUES = ["transcribe", "align", "translate", "clean", "passes"] as const;
