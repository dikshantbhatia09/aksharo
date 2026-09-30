import { statfs } from "node:fs/promises";
import { parse } from "node:path";

import { Inject, Injectable } from "@nestjs/common";

import { formatDuration } from "./alert-state.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { RedisService } from "../../common/redis/redis.service.js";
import { isQueueName, queueForJobType, type QueueName } from "../../jobs/contracts/queue-names.js";
import { QueueRegistry } from "../../jobs/queue.registry.js";
import { acquireCeilingMs, workCeilingMs } from "../../repurpose/reconciler.js";
import { FORMATS_MIN_FREE_BYTES } from "../../repurpose/repurpose.constants.js";

import type { CheckId, Finding } from "./alert-state.js";

/** A job `queued` longer than this is alerted on (owner decision 2026-09-27). */
export const QUEUED_TOO_LONG_MS = 15 * 60_000;

/**
 * How far back the event checks look. Several passes' worth, so an API restart
 * or a slow Redis costs a late alert rather than a lost one; the alert state
 * remembers what was already said, so the overlap never repeats one.
 */
export const EVENT_LOOKBACK_MS = 15 * 60_000;

/** A queue the product enqueued onto this recently is one something must consume. */
export const CONSUMED_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

/** Free space under either of these on the data volume is an alert (owner decision). */
export const DISK_MIN_FREE_FRACTION = 0.15;
export const DISK_MIN_FREE_BYTES = 5 * 1024 ** 3;

/**
 * Running rows the over-ceiling check reads. Far above anything this machine
 * runs at once; if it is ever reached the check says it saw only part
 * (`partial`), so a job past the cap is never "cleared" for being unseen.
 */
export const SCAN_LIMIT = 500;

/** Event rows read per pass; the rest are announced on a later one. */
const EVENT_SCAN_LIMIT = 500;

/** Job ids named in one queue's line; the count covers the rest. */
const IDS_PER_LINE = 3;

/** How the watch measures the volume it runs on; a seam for tests. */
export interface DiskProbe {
  /** The directory whose volume is watched: the API's working directory. */
  readonly path: string;
  readonly statfs: (path: string) => Promise<{ bsize: number; blocks: number; bavail: number }>;
}

export const DISK_PROBE = Symbol("OPS_WATCH_DISK_PROBE");

export function defaultDiskProbe(): DiskProbe {
  return { path: process.cwd(), statfs: async (path) => statfs(path) };
}

/** What one check reports for a pass. */
export interface CheckOutput {
  readonly findings: readonly Finding[];
  /** It looked at only part of what it covers: see `CheckResult.partial`. */
  readonly partial: boolean;
}

/** One check: its id and how to run it. */
export interface WatchCheck {
  readonly id: CheckId;
  readonly run: (now: Date) => Promise<CheckOutput>;
}

/**
 * The six things ops.watch looks at every minute. Each is a read: typed queries
 * on the `jobs`/`dlq`/`repurpose_runs`/`media_assets` tables, one `CLIENT LIST`
 * on Redis, one `statfs`. None of them changes anything — the watch only tells
 * a person; fixing is the lease reaper's, the reconciler's or the operator's job.
 *
 * Typed Prisma calls rather than raw SQL, so a renamed column is a compile
 * error, and the logic (which duration counts, which queue a type runs on) is
 * code the unit tests cover rather than SQL they can only mock.
 *
 * The job checks report **per queue**, not per job: a backlog behind the
 * one-at-a-time acquisition queue is one alert that grows, not a new alert for
 * every job that crosses the line and a "cleared" for every one that starts.
 *
 * Lines carry ids, queue names, closed-vocabulary error codes, counts and
 * durations. Never a payload, an error message, a URL or a user's text.
 */
@Injectable()
export class OpsWatchChecks {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queues: QueueRegistry,
    @Inject(DISK_PROBE) private readonly disk: DiskProbe,
  ) {}

  /** In the order they are reported. */
  all(): readonly WatchCheck[] {
    return [
      { id: "disk.low", run: async () => whole(await this.diskLow()) },
      { id: "queues.no-worker", run: async (now) => whole(await this.queuesWithoutWorkers(now)) },
      { id: "jobs.over-ceiling", run: async (now) => this.jobsOverCeiling(now) },
      { id: "jobs.queued-too-long", run: async (now) => whole(await this.jobsQueuedTooLong(now)) },
      { id: "dlq.new", run: async (now) => whole(await this.newDeadLetters(now)) },
      { id: "repurpose.run-failed", run: async (now) => whole(await this.failedRuns(now)) },
    ];
  }

  /**
   * (a) `running` jobs past the ceiling the repurpose reconciler would fail
   * their run for — the same functions, so the two can never disagree about
   * what "too long" means: a download past its own deadline plus ten minutes,
   * anything else past an hour plus twice the video's length. The lease reaper
   * fails the ones whose worker is gone; this reports the ones still "alive".
   */
  async jobsOverCeiling(now: Date): Promise<CheckOutput> {
    const rows = await this.prisma.job.findMany({
      where: { status: "running" },
      select: {
        id: true,
        type: true,
        projectId: true,
        params: true,
        queuedAt: true,
        startedAt: true,
      },
      orderBy: { queuedAt: "asc" },
      take: SCAN_LIMIT,
    });
    const durations = await this.knownDurations(rows);

    const over = new Map<string, { id: string; elapsedMs: number; ceilingMs: number }[]>();
    for (const row of rows) {
      const params = asRecord(row.params);
      const ceilingMs =
        row.type === "media.acquire"
          ? acquireCeilingMs({
              status: "running",
              errorCode: null,
              started: true,
              timeoutMs: finiteNumber(asRecord(params["limits"])["timeoutMs"]),
            })
          : workCeilingMs(durations.get(row.id) ?? null);
      const elapsedMs = now.getTime() - (row.startedAt ?? row.queuedAt).getTime();
      if (elapsedMs <= ceilingMs) continue;
      const queue = queueOf(row.type);
      over.set(queue, [...(over.get(queue) ?? []), { id: row.id, elapsedMs, ceilingMs }]);
    }

    const findings: Finding[] = [];
    for (const [queue, jobs] of [...over].sort(([a], [b]) => a.localeCompare(b))) {
      const longest = [...jobs].sort((a, b) => b.elapsedMs - a.elapsedMs);
      const named = longest
        .slice(0, IDS_PER_LINE)
        .map(
          (job) =>
            `${job.id} running ${formatDuration(job.elapsedMs)} (ceiling ${formatDuration(job.ceilingMs)})`,
        );
      const more = longest.length - named.length;
      findings.push({
        check: "jobs.over-ceiling",
        subject: queue,
        severity: "warning",
        line: `${queue}: ${plural(longest.length, "job")} past the ceiling; ${named.join(", ")}${more > 0 ? `, and ${String(more)} more` : ""}`,
      });
    }
    return { findings, partial: rows.length >= SCAN_LIMIT };
  }

  /**
   * The video length each running job's ceiling scales with, by job id: the
   * payload's own (`durationMs`, then `sourceDurationMs`), then its media
   * asset's, then the longest media in its project. The first that is known
   * wins; a job with none gets the base ceiling.
   */
  private async knownDurations(
    rows: readonly { id: string; projectId: string | null; params: unknown }[],
  ): Promise<Map<string, number>> {
    const mediaIds = unique(rows.map((row) => stringAt(asRecord(row.params)["mediaId"])));
    const projectIds = unique(rows.map((row) => row.projectId));
    const [media, projects] = await Promise.all([
      mediaIds.length === 0
        ? []
        : this.prisma.mediaAsset.findMany({
            where: { id: { in: mediaIds } },
            select: { id: true, durationMs: true },
          }),
      projectIds.length === 0
        ? []
        : this.prisma.mediaAsset.groupBy({
            by: ["projectId"],
            where: { projectId: { in: projectIds } },
            _max: { durationMs: true },
          }),
    ]);
    const byMedia = new Map(media.map((asset) => [asset.id, asset.durationMs]));
    const byProject = new Map(projects.map((group) => [group.projectId, group._max.durationMs]));

    const durations = new Map<string, number>();
    for (const row of rows) {
      const params = asRecord(row.params);
      const mediaId = stringAt(params["mediaId"]);
      const duration =
        finiteNumber(params["durationMs"]) ??
        finiteNumber(params["sourceDurationMs"]) ??
        (mediaId === null ? null : (byMedia.get(mediaId) ?? null)) ??
        (row.projectId === null ? null : (byProject.get(row.projectId) ?? null));
      if (duration !== null) durations.set(row.id, duration);
    }
    return durations;
  }

  /** (b) Jobs still `queued` {@link QUEUED_TOO_LONG_MS} after they were enqueued, per queue. */
  async jobsQueuedTooLong(now: Date): Promise<Finding[]> {
    const where = {
      status: "queued" as const,
      queuedAt: { lt: new Date(now.getTime() - QUEUED_TOO_LONG_MS) },
    };
    const groups = await this.prisma.job.groupBy({
      by: ["type"],
      where,
      _count: { _all: true },
    });
    const withOldest = await Promise.all(
      groups.map(async (group) => ({
        type: group.type,
        count: group._count._all,
        oldest: await this.prisma.job.findFirst({
          where: { ...where, type: group.type },
          orderBy: { queuedAt: "asc" },
          select: { id: true, queuedAt: true },
        }),
      })),
    );

    // Types that share a queue share a line: the queue is what backs up.
    type Oldest = { id: string; queuedAt: Date } | null;
    const byQueue = new Map<string, { count: number; oldest: Oldest }>();
    for (const { type, count, oldest } of withOldest) {
      const queue = queueOf(type);
      const seen = byQueue.get(queue);
      const older =
        seen === undefined ||
        seen.oldest === null ||
        (oldest !== null && oldest.queuedAt < seen.oldest.queuedAt)
          ? oldest
          : seen.oldest;
      byQueue.set(queue, { count: (seen?.count ?? 0) + count, oldest: older });
    }

    return [...byQueue]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([queue, { count, oldest: first }]) => ({
        check: "jobs.queued-too-long",
        subject: queue,
        severity: "warning",
        line:
          `${queue}: ${plural(count, "job")} queued over 15 min` +
          (first === null
            ? ""
            : `, oldest ${formatDuration(now.getTime() - first.queuedAt.getTime())} (${first.id})`),
      }));
  }

  /** (c) A dead letter recorded in the last {@link EVENT_LOOKBACK_MS}: a job that failed for good. */
  async newDeadLetters(now: Date): Promise<Finding[]> {
    const rows = await this.prisma.dlqEntry.findMany({
      where: { failedAt: { gte: new Date(now.getTime() - EVENT_LOOKBACK_MS) } },
      select: { id: true, queue: true, jobId: true, lastError: true },
      orderBy: { failedAt: "asc" },
      take: EVENT_SCAN_LIMIT,
    });
    return rows.map((row) => ({
      check: "dlq.new",
      subject: row.id,
      severity: "notice",
      line: `${row.queue} job ${row.jobId}: ${codeOf(row.lastError)}`,
    }));
  }

  /**
   * (d) A queue this product consumes with no worker connected to it: the
   * silent failure of CLAUDE.md §1, where worker-media died at every boot and
   * probe and proxy sat at "queued" for hours while every health check passed,
   * because nothing that failed was listening on a port.
   *
   * "Consumed" is read from what the product actually does: a queue with an open
   * job, or one enqueued onto in the last {@link CONSUMED_LOOKBACK_MS}. A static
   * list would page forever about a queue this deployment never uses
   * (`publish.dispatch`), or miss one added next month. An open job makes it
   * critical: someone is waiting on it now. Job types are counted under the
   * queue they run on (`queueForJobType`), which is what a worker listens to.
   *
   * Workers are found in one `CLIENT LIST` rather than BullMQ's
   * `Queue.getWorkers()`, because that only recognises the Node library's
   * client names (`bull:<base64 queue>`) and the Python library names its
   * connections `bull:<queue>` — every `ai.*` queue would read as unattended.
   */
  async queuesWithoutWorkers(now: Date): Promise<Finding[]> {
    const since = new Date(now.getTime() - CONSUMED_LOOKBACK_MS);
    const groups = await this.prisma.job.groupBy({
      by: ["type", "status"],
      where: { OR: [{ queuedAt: { gt: since } }, { status: { in: ["queued", "running"] } }] },
      _count: { _all: true },
    });
    const open = new Map<QueueName, number>();
    for (const group of groups) {
      if (!isQueueName(group.type)) continue;
      const queue = queueForJobType(group.type);
      const waiting = group.status === "queued" || group.status === "running";
      open.set(queue, (open.get(queue) ?? 0) + (waiting ? group._count._all : 0));
    }
    if (open.size === 0) return [];

    const list = await this.redis.client.client("LIST");
    const names = clientNames(typeof list === "string" ? list : String(list));

    const findings: Finding[] = [];
    for (const [queue, count] of [...open].sort(([a], [b]) => a.localeCompare(b))) {
      if (countWorkers(names, this.queues.prefix, queue) > 0) continue;
      findings.push({
        check: "queues.no-worker",
        subject: queue,
        severity: count > 0 ? "critical" : "warning",
        line: `${queue}: no worker connected${count > 0 ? `, ${plural(count, "open job")} waiting` : ""}`,
      });
    }
    return findings;
  }

  /**
   * (e) Free space on the volume the API runs from, which on this machine is
   * also Postgres's, Redis's, MinIO's and the workers' temp directory: a full C:
   * takes the database down with it. Under {@link DISK_MIN_FREE_BYTES} is
   * critical, under {@link DISK_MIN_FREE_FRACTION} a warning.
   *
   * Under {@link FORMATS_MIN_FREE_BYTES} it is also its own finding: Autopilot
   * is holding every clip's other shapes and images. On 2026-09-30 that went
   * on for hours with no word of it - the 15% warning on a 465 GB disk is on
   * almost all the time, so its six-hourly reminder said nothing new - while
   * the run page said "Being made…".
   */
  async diskLow(): Promise<Finding[]> {
    const stats = await this.disk.statfs(this.disk.path);
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    if (total <= 0) return [];
    const fraction = free / total;
    const critical = free < DISK_MIN_FREE_BYTES;

    // The volume root only (`C:\`): the working directory's full path names the
    // machine's user account, which is not the alert's business.
    const volume = parse(this.disk.path).root || this.disk.path;
    const findings: Finding[] = [];
    if (critical || fraction < DISK_MIN_FREE_FRACTION) {
      findings.push({
        check: "disk.low",
        subject: volume,
        severity: critical ? "critical" : "warning",
        line: `${volume} ${formatBytes(free)} free of ${formatBytes(total)} (${(fraction * 100).toFixed(1)}%)`,
      });
    }
    if (free < FORMATS_MIN_FREE_BYTES) {
      findings.push({
        check: "disk.low",
        subject: `${volume} clip formats`,
        severity: "warning",
        line: `${volume} under ${formatBytes(FORMATS_MIN_FREE_BYTES)} free: Autopilot is holding clips' other sizes and images until there is room`,
      });
    }
    return findings;
  }

  /** (f) A clips run that failed in the last {@link EVENT_LOOKBACK_MS}. Informational. */
  async failedRuns(now: Date): Promise<Finding[]> {
    const rows = await this.prisma.repurposeRun.findMany({
      where: {
        status: "failed",
        updatedAt: { gte: new Date(now.getTime() - EVENT_LOOKBACK_MS) },
      },
      select: { id: true, failureCode: true },
      orderBy: { updatedAt: "asc" },
      take: EVENT_SCAN_LIMIT,
    });
    return rows.map((row) => {
      const code = safeCode(row.failureCode);
      return {
        check: "repurpose.run-failed",
        // With the code, so a run that is retried and fails for a different
        // reason is news; the same reason again within a day is not.
        subject: `${row.id}:${code}`,
        severity: "info",
        line: `run ${row.id}: ${code}`,
      };
    });
  }
}

function whole(findings: readonly Finding[]): CheckOutput {
  return { findings, partial: false };
}

/** The queue a job type runs on; a type outside the queue table stands for itself. */
function queueOf(type: string): string {
  return isQueueName(type) ? queueForJobType(type) : type;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringAt(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function unique(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function plural(n: number, one: string): string {
  return `${String(n)} ${n === 1 ? one : `${one}s`}`;
}

/** Every named client in a `CLIENT LIST` reply. */
export function clientNames(list: string): string[] {
  const names: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    const match = /(?:^|\s)name=(\S+)/.exec(line);
    if (match?.[1] !== undefined) names.push(match[1]);
  }
  return names;
}

/**
 * Worker connections on one queue, in both client-name dialects:
 * `bullmq` for Node names a worker `<prefix>:<base64 queue>` (worker-media,
 * render) and `bullmq` for Python `<prefix>:<queue>` (worker-ai), each with an
 * optional `:w:<worker name>` suffix.
 */
export function countWorkers(names: readonly string[], prefix: string, queue: string): number {
  const bases = [`${prefix}:${Buffer.from(queue).toString("base64")}`, `${prefix}:${queue}`];
  return names.filter((name) =>
    bases.some((base) => name === base || name.startsWith(`${base}:w:`)),
  ).length;
}

/** A dead letter's error code, if it is one; never its message. */
function codeOf(lastError: unknown): string {
  if (lastError === null || typeof lastError !== "object") return "no error code";
  return safeCode((lastError as { code?: unknown }).code);
}

/** Error codes are `namespace/slug`; anything else is not repeated. */
function safeCode(code: unknown): string {
  return typeof code === "string" && /^[a-z0-9_.-]{1,40}\/[a-z0-9_.-]{1,60}$/.test(code)
    ? code
    : "no error code";
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return gib >= 1 ? `${gib.toFixed(1)} GiB` : `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
}
