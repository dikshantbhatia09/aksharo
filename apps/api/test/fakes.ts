/**
 * In-memory stand-ins for the pieces of infrastructure the unit suites do not
 * want: Prisma, Redis and BullMQ.
 *
 * They implement only the query shapes `src/jobs`, `src/credits` and
 * `src/realtime` actually use — a general fake ORM would be a second Prisma to
 * maintain and would prove nothing the real integration suite does not.
 * Everything they cannot answer throws loudly rather than returning a plausible
 * empty result, so a new call site is a failing test, not a silent `undefined`.
 */
import { ulid } from "ulid";

import type { Job, JobEvent, JobStatus, PlanKey } from "@prisma/client";

type Row = Record<string, unknown>;

/** `{ field: value }` or `{ field: { in: [...] } }`; `undefined` matches anything. */
function matches(row: Row, where: Row | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (expected === undefined) continue;
    const actual = row[key];
    if (expected !== null && typeof expected === "object" && "in" in expected) {
      const allowed = (expected as { in: unknown[] }).in;
      if (!allowed.includes(actual)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}

function sort<T extends Row>(rows: T[], orderBy: Row | undefined): T[] {
  if (orderBy === undefined) return rows;
  const [field, direction] = Object.entries(orderBy)[0] as [string, "asc" | "desc"];
  return [...rows].sort((a, b) => {
    const left = a[field];
    const right = b[field];
    const cmp =
      left instanceof Date && right instanceof Date
        ? left.getTime() - right.getTime()
        : String(left) < String(right)
          ? -1
          : String(left) > String(right)
            ? 1
            : 0;
    return direction === "desc" ? -cmp : cmp;
  });
}

function paginate<T extends Row>(rows: T[], args: Row): T[] {
  let page = rows;
  const cursor = args["cursor"] as { id: string } | undefined;
  if (cursor !== undefined) {
    const index = page.findIndex((row) => row["id"] === cursor.id);
    page = index < 0 ? [] : page.slice(index + Number(args["skip"] ?? 0));
  }
  const take = args["take"] as number | undefined;
  return take === undefined ? page : page.slice(0, take);
}

export interface FakeProject {
  readonly id: string;
  readonly workspaceId: string;
  readonly deletedAt: Date | null;
}

export interface FakeMembership {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly status: string;
}

/** The mutable world the fake Prisma reads and writes. */
export class FakeDb {
  readonly jobs = new Map<string, Job>();
  readonly events: JobEvent[] = [];
  readonly projects: FakeProject[] = [];
  readonly memberships: FakeMembership[] = [];
  /** `workspaceId -> plan`; absent means no live subscription (i.e. free). */
  readonly plans = new Map<string, PlanKey>();

  job(overrides: Partial<Job> = {}): Job {
    const id = overrides.id ?? ulid();
    const job: Job = {
      id,
      workspaceId: "01JCWORKSPACE00000000000000".slice(0, 26),
      projectId: null,
      type: "ai.transcribe",
      status: "queued" as JobStatus,
      priority: 3,
      params: {},
      result: null,
      progress: 0,
      etaMs: null,
      creditHoldId: null,
      creditsChargedTenths: 0,
      provider: null,
      model: null,
      costMinor: null,
      egressBytes: null,
      error: null,
      queuedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      jobKey: `key-${id}`,
      attemptId: ulid(),
      maxQueueWaitMs: 900_000,
      ...overrides,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  eventNames(jobId?: string): string[] {
    return this.events
      .filter((event) => jobId === undefined || event.jobId === jobId)
      .map((event) => (event.data as { event?: string } | null)?.event ?? "");
  }
}

/** A `PrismaService` substitute covering the jobs, events, plan and room queries. */
export function createFakePrisma(db: FakeDb) {
  const jobRows = (): Job[] => [...db.jobs.values()];

  return {
    job: {
      create: async ({ data }: { data: Row }): Promise<Job> =>
        db.job({
          ...(data as Partial<Job>),
          queuedAt: (data["queuedAt"] as Date | undefined) ?? new Date(),
        }),
      update: async ({ where, data }: { where: { id: string }; data: Row }): Promise<Job> => {
        const current = db.jobs.get(where.id);
        if (current === undefined) throw new Error(`no job ${where.id}`);
        const next = { ...current, ...data } as Job;
        db.jobs.set(next.id, next);
        return next;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Row;
        data: Row;
      }): Promise<{ count: number }> => {
        let count = 0;
        for (const job of jobRows()) {
          if (!matches(job as unknown as Row, where)) continue;
          db.jobs.set(job.id, { ...job, ...data } as Job);
          count += 1;
        }
        return { count };
      },
      delete: async ({ where }: { where: { id: string } }): Promise<Job> => {
        const job = db.jobs.get(where.id);
        if (job === undefined) throw new Error(`no job ${where.id}`);
        db.jobs.delete(where.id);
        return job;
      },
      findUnique: async ({ where }: { where: { id: string } }): Promise<Job | null> =>
        db.jobs.get(where.id) ?? null,
      findFirst: async (args: Row): Promise<Job | null> => {
        const rows = sort(
          jobRows().filter((job) => matches(job as unknown as Row, args["where"] as Row)),
          args["orderBy"] as Row,
        );
        return rows[0] ?? null;
      },
      findMany: async (args: Row): Promise<Job[]> =>
        paginate(
          sort(
            jobRows().filter((job) => matches(job as unknown as Row, args["where"] as Row)),
            args["orderBy"] as Row,
          ),
          args,
        ),
      count: async (args: Row): Promise<number> =>
        jobRows().filter((job) => matches(job as unknown as Row, args["where"] as Row)).length,
      aggregate: async (args: Row): Promise<{ _sum: { creditsChargedTenths: number | null } }> => {
        const rows = jobRows().filter((job) =>
          matches(job as unknown as Row, args["where"] as Row),
        );
        if (rows.length === 0) return { _sum: { creditsChargedTenths: null } };
        return {
          _sum: {
            creditsChargedTenths: rows.reduce((total, job) => total + job.creditsChargedTenths, 0),
          },
        };
      },
    },
    jobEvent: {
      create: async ({ data }: { data: Row }): Promise<JobEvent> => {
        const event = {
          at: new Date(),
          level: "info",
          ...data,
        } as unknown as JobEvent;
        db.events.push(event);
        return event;
      },
      findMany: async (args: Row): Promise<JobEvent[]> =>
        paginate(
          sort(
            db.events.filter((event) => matches(event as unknown as Row, args["where"] as Row)),
            args["orderBy"] as Row,
          ),
          args,
        ),
    },
    subscription: {
      findFirst: async (args: Row): Promise<{ plan: { key: PlanKey } } | null> => {
        const where = args["where"] as { workspaceId: string };
        const plan = db.plans.get(where.workspaceId);
        return plan === undefined ? null : { plan: { key: plan } };
      },
    },
    project: {
      findFirst: async (args: Row): Promise<{ workspaceId: string } | null> => {
        const project = db.projects.find((row) =>
          matches(row as unknown as Row, args["where"] as Row),
        );
        return project === undefined ? null : { workspaceId: project.workspaceId };
      },
    },
    membership: {
      findFirst: async (args: Row): Promise<{ id: string } | null> => {
        const membership = db.memberships.find((row) =>
          matches(row as unknown as Row, args["where"] as Row),
        );
        return membership === undefined ? null : { id: membership.id };
      },
    },
  };
}

export type FakePrisma = ReturnType<typeof createFakePrisma>;

/** Records everything the producer put on a queue, without a Redis anywhere. */
export class FakeQueueRegistry {
  readonly added: { queue: string; name: string; data: unknown; options: Row }[] = [];
  readonly removed: string[] = [];
  readonly prefix = "test";
  /** Set to make the next `add` reject, exercising the unwind path. */
  failNextAdd = false;

  queue(name: string) {
    return {
      add: async (jobName: string, data: unknown, options: Row): Promise<{ id: string }> => {
        if (this.failNextAdd) {
          this.failNextAdd = false;
          throw new Error("redis is down");
        }
        this.added.push({ queue: name, name: jobName, data, options });
        return { id: String(options["jobId"]) };
      },
      getJob: async (id: string) => ({
        id,
        remove: async (): Promise<void> => {
          this.removed.push(id);
        },
      }),
    };
  }

  optionsFor(input: { jobId: string; attemptId: string; priority: number }): Row {
    return { jobId: `${input.jobId}-${input.attemptId}`, priority: input.priority, attempts: 2 };
  }
}

/** A `RedisService` substitute good enough for the module graph to boot. */
export function createFakeRedis() {
  const client = {
    status: "ready" as const,
    on: () => client,
    publish: async () => 1,
    subscribe: async () => 1,
    unsubscribe: async () => 1,
    duplicate: () => createFakeRedis().client,
    disconnect: () => undefined,
    quit: async () => "OK",
    ping: async () => "PONG",
  };
  return {
    client,
    ping: async (): Promise<void> => undefined,
    onModuleDestroy: async (): Promise<void> => undefined,
  };
}
