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
import { monotonicFactory } from "ulid";

/**
 * Monotonic, like `src/jobs/ids.ts`: fixtures are listed and paginated by id, so
 * two rows minted in the same millisecond have to sort in creation order or a
 * test asserting "newest first" is asserting a coin flip.
 */
const ulid = monotonicFactory();

import type {
  AuditLog,
  DlqEntry,
  Job,
  JobEvent,
  JobStatus,
  Notification,
  PlanKey,
} from "@prisma/client";

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

/**
 * `matches`, plus the one `{ OR: [...] }` shape the DLQ queries use.
 *
 * The JSONB `string_contains` filter behind `?reason=` is deliberately NOT
 * modelled: reproducing Postgres JSON path semantics in a fake would be testing
 * the fake. `test/dlq.e2e-spec.ts` covers that filter against a real database.
 */
function matchesDlq(row: DlqEntry, where: Row | undefined): boolean {
  if (where === undefined) return true;
  const { OR, ...rest } = where as { OR?: Row[] };
  if (!matches(row as unknown as Row, rest as Row)) return false;
  if (OR === undefined) return true;
  return OR.some((clause) => matches(row as unknown as Row, clause));
}

/** Prisma accepts an array of orderings; the fake sorts on the first. */
function firstOrderBy(orderBy: unknown): Row | undefined {
  if (Array.isArray(orderBy)) return orderBy[0] as Row | undefined;
  return orderBy as Row | undefined;
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

export interface FakeUser {
  readonly id: string;
  readonly isAdmin: boolean;
  readonly deletedAt: Date | null;
  /** B02b: `JobsService.notifyCreditsShortfall`'s workspace-owner lookup. */
  readonly email?: string;
  readonly name?: string | null;
  readonly locale?: string;
}

/** B02b: `JobsService.notifyCreditsShortfall`'s `workspace.findFirst`. */
export interface FakeWorkspace {
  readonly id: string;
  readonly ownerId: string;
  readonly deletedAt: Date | null;
}

/** B02b: the balance `JobsService.notifyCreditsShortfall` reports as "minutes left". */
export interface FakeCreditAccount {
  readonly workspaceId: string;
  readonly balanceTenths: number;
}

/**
 * B02b: `AdmissionService.admit`'s enqueued-credit sum. Flattened onto
 * `workspaceId` directly rather than an `accountId` indirection through
 * `FakeCreditAccount` — the fake only ever needs to answer "holds `status =
 * 'held'` for this workspace", never a real join.
 */
export interface FakeCreditHold {
  readonly id: string;
  readonly workspaceId: string;
  readonly status: "held" | "settled" | "released" | "partially_settled";
  readonly amountTenths: number;
}

/** The mutable world the fake Prisma reads and writes. */
export class FakeDb {
  readonly jobs = new Map<string, Job>();
  readonly events: JobEvent[] = [];
  readonly projects: FakeProject[] = [];
  readonly memberships: FakeMembership[] = [];
  /** `workspaceId -> plan`; absent means no live subscription (i.e. free). */
  readonly plans = new Map<string, PlanKey>();
  /** A08b: dead-letter entries, the admin users who may act on them, and the trail. */
  readonly dlq = new Map<string, DlqEntry>();
  readonly users = new Map<string, FakeUser>();
  readonly workspaces = new Map<string, FakeWorkspace>();
  /** Keyed by `workspaceId`, like the real table's unique index. */
  readonly creditAccounts = new Map<string, FakeCreditAccount>();
  readonly creditHolds = new Map<string, FakeCreditHold>();
  readonly audit: AuditLog[] = [];
  /** A25: in-app notifications. */
  readonly notifications = new Map<string, Notification>();

  notification(overrides: Partial<Notification> = {}): Notification {
    const row: Notification = {
      id: overrides.id ?? ulid(),
      userId: "01JCUSER00000000000000000A",
      workspaceId: null,
      kind: "export-ready",
      data: {},
      readAt: null,
      createdAt: new Date(),
      ...overrides,
    };
    this.notifications.set(row.id, row);
    return row;
  }

  user(overrides: Partial<FakeUser> = {}): FakeUser {
    const user: FakeUser = {
      id: ulid(),
      isAdmin: false,
      deletedAt: null,
      ...overrides,
    };
    this.users.set(user.id, user);
    return user;
  }

  workspace(overrides: Partial<FakeWorkspace> = {}): FakeWorkspace {
    const workspace: FakeWorkspace = {
      id: ulid(),
      ownerId: ulid(),
      deletedAt: null,
      ...overrides,
    };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  creditAccount(overrides: Partial<FakeCreditAccount> = {}): FakeCreditAccount {
    const account: FakeCreditAccount = {
      workspaceId: ulid(),
      balanceTenths: 0,
      ...overrides,
    };
    this.creditAccounts.set(account.workspaceId, account);
    return account;
  }

  creditHold(overrides: Partial<FakeCreditHold> = {}): FakeCreditHold {
    const hold: FakeCreditHold = {
      id: ulid(),
      workspaceId: "01JCWORKSPACE00000000000000".slice(0, 26),
      status: "held",
      amountTenths: 0,
      ...overrides,
    };
    this.creditHolds.set(hold.id, hold);
    return hold;
  }

  dlqEntry(overrides: Partial<DlqEntry> = {}): DlqEntry {
    const id = overrides.id ?? ulid();
    const entry = {
      id,
      jobId: ulid(),
      workspaceId: "01JCWORKSPACE00000000000000".slice(0, 26),
      projectId: null,
      queue: "ai.transcribe",
      jobKey: `key-${id}`,
      attemptId: ulid(),
      attemptNo: 1,
      attempts: 1,
      payload: {},
      lastError: null,
      worstCaseTenths: 0,
      failedAt: new Date(),
      status: "pending",
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
      ...overrides,
    } as DlqEntry;
    this.dlq.set(entry.id, entry);
    return entry;
  }

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
      attemptNo: 1,
      maxQueueWaitMs: 900_000,
      dlq: false,
      dlqReason: null,
      dlqAt: null,
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
  const dlqRows = (): DlqEntry[] => [...db.dlq.values()];

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
    user: {
      findUnique: async ({ where }: { where: { id: string } }): Promise<FakeUser | null> =>
        db.users.get(where.id) ?? null,
    },
    // B02b: `JobsService.notifyCreditsShortfall`'s workspace-owner lookup.
    workspace: {
      findFirst: async (
        args: Row,
      ): Promise<{
        owner: { id: string; email: string; name: string | null; locale: string };
      } | null> => {
        const workspace = [...db.workspaces.values()].find((row) =>
          matches(row as unknown as Row, args["where"] as Row),
        );
        if (workspace === undefined) return null;
        const owner = db.users.get(workspace.ownerId);
        if (owner === undefined) return null;
        return {
          owner: {
            id: owner.id,
            email: owner.email ?? `${owner.id}@example.test`,
            name: owner.name ?? null,
            locale: owner.locale ?? "en-IN",
          },
        };
      },
    },
    creditAccount: {
      findUnique: async ({
        where,
      }: {
        where: { workspaceId: string };
      }): Promise<FakeCreditAccount | null> => db.creditAccounts.get(where.workspaceId) ?? null,
    },
    // B02b: `AdmissionService.admit`'s enqueued-credit sum. `where` is the one
    // shape production code sends — `{ status, account: { workspaceId } }` — so
    // this reads it directly rather than teaching the generic `matches()`
    // helper a relation filter for a single call site.
    creditHold: {
      aggregate: async (args: Row): Promise<{ _sum: { amountTenths: number | null } }> => {
        const where = args["where"] as { status?: string; account?: { workspaceId?: string } };
        const rows = [...db.creditHolds.values()].filter(
          (row) =>
            (where.status === undefined || row.status === where.status) &&
            (where.account?.workspaceId === undefined ||
              row.workspaceId === where.account.workspaceId),
        );
        if (rows.length === 0) return { _sum: { amountTenths: null } };
        return {
          _sum: { amountTenths: rows.reduce((total, row) => total + row.amountTenths, 0) },
        };
      },
    },
    notification: {
      create: async ({ data }: { data: Row }): Promise<Notification> =>
        db.notification(data as Partial<Notification>),
      findMany: async (args: Row): Promise<Notification[]> =>
        paginate(
          sort(
            [...db.notifications.values()].filter((row) =>
              matches(row as unknown as Row, args["where"] as Row),
            ),
            args["orderBy"] as Row,
          ),
          args,
        ),
      findFirst: async (args: Row): Promise<Notification | null> =>
        [...db.notifications.values()].find((row) =>
          matches(row as unknown as Row, args["where"] as Row),
        ) ?? null,
      count: async (args: Row): Promise<number> =>
        [...db.notifications.values()].filter((row) =>
          matches(row as unknown as Row, args["where"] as Row),
        ).length,
      updateMany: async ({
        where,
        data,
      }: {
        where: Row;
        data: Row;
      }): Promise<{ count: number }> => {
        let count = 0;
        for (const row of [...db.notifications.values()]) {
          if (!matches(row as unknown as Row, where)) continue;
          db.notifications.set(row.id, { ...row, ...data } as Notification);
          count += 1;
        }
        return { count };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }): Promise<AuditLog> => {
        const row = { at: new Date(), ...data } as unknown as AuditLog;
        db.audit.push(row);
        return row;
      },
    },
    dlqEntry: {
      // `where` is the compound `jobId_attemptId` key; the fake only ever sees
      // that one, which is the only unique index on the table besides the id.
      upsert: async ({
        where,
        create,
      }: {
        where: { jobId_attemptId: { jobId: string; attemptId: string } };
        create: Row;
      }): Promise<DlqEntry> => {
        const key = where.jobId_attemptId;
        const existing = dlqRows().find(
          (row) => row.jobId === key.jobId && row.attemptId === key.attemptId,
        );
        if (existing !== undefined) return existing;
        return db.dlqEntry(create as Partial<DlqEntry>);
      },
      create: async ({ data }: { data: Row }): Promise<DlqEntry> =>
        db.dlqEntry(data as Partial<DlqEntry>),
      findUnique: async ({ where }: { where: { id: string } }): Promise<DlqEntry | null> =>
        db.dlq.get(where.id) ?? null,
      findFirst: async (args: Row): Promise<DlqEntry | null> => {
        const rows = sort(
          dlqRows().filter((row) => matchesDlq(row, args["where"] as Row)),
          firstOrderBy(args["orderBy"]),
        );
        return rows[0] ?? null;
      },
      findMany: async (args: Row): Promise<DlqEntry[]> =>
        paginate(
          sort(
            dlqRows().filter((row) => matchesDlq(row, args["where"] as Row)),
            firstOrderBy(args["orderBy"]),
          ),
          args,
        ),
      update: async ({ where, data }: { where: { id: string }; data: Row }): Promise<DlqEntry> => {
        const current = db.dlq.get(where.id);
        if (current === undefined) throw new Error(`no dlq entry ${where.id}`);
        const next = { ...current, ...data } as DlqEntry;
        db.dlq.set(next.id, next);
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
        for (const row of dlqRows()) {
          if (!matchesDlq(row, where)) continue;
          db.dlq.set(row.id, { ...row, ...data } as DlqEntry);
          count += 1;
        }
        return { count };
      },
      groupBy: async (args: Row): Promise<{ queue: string; _count: { _all: number } }[]> => {
        const rows = dlqRows().filter((row) => matchesDlq(row, args["where"] as Row));
        const counts = new Map<string, number>();
        for (const row of rows) counts.set(row.queue, (counts.get(row.queue) ?? 0) + 1);
        return [...counts].map(([queue, total]) => ({ queue, _count: { _all: total } }));
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

/**
 * A Redis stand-in with actual storage, for the notify suites (A25).
 *
 * {@link createFakeRedis} answers enough for a module graph to construct; this one
 * remembers what was written, because suppression, delivery receipts and the
 * development outbox are all "did the right key end up with the right value?".
 * Only the commands that module issues are implemented.
 */
export function createMemoryRedis() {
  const store = new Map<string, string>();
  const lists = new Map<string, string[]>();

  const client = {
    status: "ready" as const,
    store,
    lists,
    on: () => client,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<"OK"> {
      store.set(key, value);
      return "OK";
    },
    async del(...keys: string[]): Promise<number> {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) removed += 1;
        if (lists.delete(key)) removed += 1;
      }
      return removed;
    },
    async exists(key: string): Promise<number> {
      return store.has(key) || lists.has(key) ? 1 : 0;
    },
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? [];
      return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
    },
    multi() {
      const operations: (() => void)[] = [];
      const chain = {
        lpush(key: string, value: string) {
          operations.push(() => {
            lists.set(key, [value, ...(lists.get(key) ?? [])]);
          });
          return chain;
        },
        ltrim(key: string, start: number, stop: number) {
          operations.push(() => {
            lists.set(key, (lists.get(key) ?? []).slice(start, stop + 1));
          });
          return chain;
        },
        expire() {
          return chain;
        },
        async exec(): Promise<unknown[]> {
          for (const operation of operations) operation();
          return [];
        },
      };
      return chain;
    },
    disconnect: () => undefined,
    async quit(): Promise<"OK"> {
      return "OK";
    },
    async ping(): Promise<"PONG"> {
      return "PONG";
    },
  };

  return client;
}

export type MemoryRedis = ReturnType<typeof createMemoryRedis>;
