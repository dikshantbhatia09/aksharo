/* eslint-disable security/detect-object-injection -- a test fake indexing its own rows by field name */
/**
 * An in-memory stand-in for the slice of Prisma channel automations use, for
 * their unit tests (no database, no Docker), like the publishing module's.
 *
 * It understands the query shapes the module sends - equality, `in`, `not`,
 * `lt`/`lte`/`gt`/`gte`, `OR`, relation filters it can ignore (`workspace`,
 * `user`), `{ increment }` updates, `include: { run }` - and enforces the two
 * unique indexes the module leans on: one watch per (workspace, channel) and
 * one row per (watch, video). A violation throws Prisma's `P2002` shape.
 *
 * Not a test file (no `.test.ts`); only the automations tests import it.
 */

export type Row = Record<string, unknown>;

export interface Tables {
  sourceWatch: Row[];
  sourceWatchVideo: Row[];
  repurposeRun: Row[];
  membership: Row[];
}

/** Relation filters the fake treats as always true: the tests set up what they need directly. */
const IGNORED_RELATIONS = new Set(["workspace", "user"]);

function compare(value: unknown, other: unknown): number {
  const a = value instanceof Date ? value.getTime() : (value as number);
  const b = other instanceof Date ? other.getTime() : (other as number);
  return a < b ? -1 : a > b ? 1 : 0;
}

function same(value: unknown, other: unknown): boolean {
  if (value instanceof Date && other instanceof Date) return value.getTime() === other.getTime();
  return value === other;
}

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (
    condition === null ||
    typeof condition !== "object" ||
    condition instanceof Date ||
    Array.isArray(condition)
  ) {
    return same(value ?? null, condition);
  }
  for (const [op, operand] of Object.entries(condition as Record<string, unknown>)) {
    switch (op) {
      case "in":
        if (!(operand as unknown[]).some((entry) => same(value, entry))) return false;
        break;
      case "notIn":
        if ((operand as unknown[]).some((entry) => same(value, entry))) return false;
        break;
      case "not":
        if (same(value ?? null, operand)) return false;
        break;
      case "lt":
        if (value === null || value === undefined || compare(value, operand) >= 0) return false;
        break;
      case "lte":
        if (value === null || value === undefined || compare(value, operand) > 0) return false;
        break;
      case "gt":
        if (value === null || value === undefined || compare(value, operand) <= 0) return false;
        break;
      case "gte":
        if (value === null || value === undefined || compare(value, operand) < 0) return false;
        break;
      default:
        throw new Error(`memory prisma: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (where === undefined) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === "OR") {
      if (!(condition as Record<string, unknown>[]).some((branch) => matches(row, branch))) {
        return false;
      }
      continue;
    }
    if (IGNORED_RELATIONS.has(key)) continue;
    if (!fieldMatches(row[key], condition)) return false;
  }
  return true;
}

function applyData(row: Row, data: Record<string, unknown>): Row {
  const next: Row = { ...row };
  for (const [key, value] of Object.entries(data)) {
    if (
      value !== null &&
      typeof value === "object" &&
      !(value instanceof Date) &&
      !Array.isArray(value) &&
      "increment" in value
    ) {
      next[key] =
        ((row[key] as number | undefined) ?? 0) + (value as { increment: number }).increment;
    } else {
      next[key] = value;
    }
  }
  next["updatedAt"] = new Date();
  return next;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const orders = (
    Array.isArray(orderBy) ? orderBy : orderBy === undefined ? [] : [orderBy]
  ) as Record<string, "asc" | "desc">[];
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [key, direction] = Object.entries(order)[0] ?? [];
      if (key === undefined) continue;
      const result =
        compare(a[key], b[key]) ||
        (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0);
      if (result !== 0) return direction === "desc" ? -result : result;
    }
    return 0;
  });
}

function pick(row: Row, select: Record<string, unknown> | undefined): Row {
  if (select === undefined) return { ...row };
  const out: Row = {};
  for (const key of Object.keys(select)) out[key] = row[key];
  return out;
}

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

interface Query {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  take?: number;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

const WATCH_DEFAULTS: Row = {
  kind: "youtube_channel",
  handle: null,
  backfillCount: 0,
  state: "active",
  stateReason: null,
  lastCheckedAt: null,
  checkFailures: 0,
  lastErrorCode: null,
  cursor: null,
};

const VIDEO_DEFAULTS: Row = {
  state: "pending",
  reason: null,
  backfill: false,
  runId: null,
  attempts: 0,
  claimedAt: null,
};

/** A Prisma-shaped object over {@link Tables}. */
export function memoryPrisma(tables: Tables) {
  const now = (): Date => new Date();
  const videosWithRun = (rows: Row[], include: Record<string, unknown> | undefined): Row[] =>
    include?.["run"] === undefined
      ? rows
      : rows.map((row) => {
          const run = tables.repurposeRun.find((candidate) => candidate["id"] === row["runId"]);
          return { ...row, run: run === undefined ? null : { status: run["status"] } };
        });

  return {
    tables,
    sourceWatch: {
      async findMany(query: Query = {}): Promise<Row[]> {
        const rows = sortRows(
          tables.sourceWatch.filter((row) => matches(row, query.where)),
          query.orderBy,
        );
        return (query.take === undefined ? rows : rows.slice(0, query.take)).map((row) =>
          pick(row, query.select),
        );
      },
      async findFirst(query: Query = {}): Promise<Row | null> {
        const row = tables.sourceWatch.find((candidate) => matches(candidate, query.where));
        return row === undefined ? null : pick(row, query.select);
      },
      async findUnique(query: Query): Promise<Row | null> {
        const key = query.where?.["workspaceId_channelId"] as Row | undefined;
        const where = key ?? query.where;
        const row = tables.sourceWatch.find((candidate) => matches(candidate, where));
        return row === undefined ? null : pick(row, query.select);
      },
      async count(query: Query = {}): Promise<number> {
        return tables.sourceWatch.filter((row) => matches(row, query.where)).length;
      },
      async create({ data }: { data: Row }): Promise<Row> {
        if (
          tables.sourceWatch.some(
            (row) =>
              row["workspaceId"] === data["workspaceId"] && row["channelId"] === data["channelId"],
          )
        ) {
          throw uniqueViolation();
        }
        const row = { ...WATCH_DEFAULTS, createdAt: now(), updatedAt: now(), ...data };
        tables.sourceWatch.push(row);
        return { ...row };
      },
      async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
        const index = tables.sourceWatch.findIndex((row) => matches(row, where));
        if (index === -1) throw Object.assign(new Error("not found"), { code: "P2025" });
        const next = applyData(tables.sourceWatch[index] as Row, data);
        tables.sourceWatch[index] = next;
        return { ...next };
      },
      async updateMany({ where, data }: { where: Row; data: Row }): Promise<{ count: number }> {
        let count = 0;
        tables.sourceWatch = tables.sourceWatch.map((row) => {
          if (!matches(row, where)) return row;
          count += 1;
          return applyData(row, data);
        });
        return { count };
      },
      async deleteMany({ where }: { where: Row }): Promise<{ count: number }> {
        const gone = tables.sourceWatch
          .filter((row) => matches(row, where))
          .map((row) => row["id"]);
        tables.sourceWatch = tables.sourceWatch.filter((row) => !gone.includes(row["id"]));
        tables.sourceWatchVideo = tables.sourceWatchVideo.filter(
          (row) => !gone.includes(row["watchId"]),
        );
        return { count: gone.length };
      },
    },
    sourceWatchVideo: {
      async findMany(query: Query = {}): Promise<Row[]> {
        const rows = sortRows(
          tables.sourceWatchVideo.filter((row) => matches(row, query.where)),
          query.orderBy,
        );
        const taken = query.take === undefined ? rows : rows.slice(0, query.take);
        return videosWithRun(taken, query.include).map((row) =>
          query.select === undefined ? { ...row } : pick(row, query.select),
        );
      },
      async count(query: Query = {}): Promise<number> {
        return tables.sourceWatchVideo.filter((row) => matches(row, query.where)).length;
      },
      async groupBy(query: { by: string[]; where?: Record<string, unknown> }): Promise<Row[]> {
        const groups = new Map<unknown, number>();
        for (const row of tables.sourceWatchVideo.filter((candidate) =>
          matches(candidate, query.where),
        )) {
          const key = row[query.by[0] ?? "watchId"];
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        return [...groups].map(([key, count]) => ({
          [query.by[0] ?? "watchId"]: key,
          _count: { _all: count },
        }));
      },
      async createMany({
        data,
        skipDuplicates,
      }: {
        data: Row[];
        skipDuplicates?: boolean;
      }): Promise<{ count: number }> {
        let count = 0;
        for (const entry of data) {
          const exists = tables.sourceWatchVideo.some(
            (row) => row["watchId"] === entry["watchId"] && row["videoId"] === entry["videoId"],
          );
          if (exists) {
            if (skipDuplicates === true) continue;
            throw uniqueViolation();
          }
          tables.sourceWatchVideo.push({
            ...VIDEO_DEFAULTS,
            createdAt: now(),
            updatedAt: now(),
            ...entry,
          });
          count += 1;
        }
        return { count };
      },
      async update({ where, data }: { where: Row; data: Row }): Promise<Row> {
        const index = tables.sourceWatchVideo.findIndex((row) => matches(row, where));
        if (index === -1) throw Object.assign(new Error("not found"), { code: "P2025" });
        const next = applyData(tables.sourceWatchVideo[index] as Row, data);
        tables.sourceWatchVideo[index] = next;
        return { ...next };
      },
      async updateMany({ where, data }: { where: Row; data: Row }): Promise<{ count: number }> {
        let count = 0;
        tables.sourceWatchVideo = tables.sourceWatchVideo.map((row) => {
          if (!matches(row, where)) return row;
          count += 1;
          return applyData(row, data);
        });
        return { count };
      },
    },
    repurposeRun: {
      async findFirst(query: Query = {}): Promise<Row | null> {
        const rows = sortRows(
          tables.repurposeRun.filter((row) => matches(row, query.where)),
          query.orderBy,
        );
        const row = rows[0];
        return row === undefined ? null : pick(row, query.select);
      },
    },
    membership: {
      async findFirst(query: Query = {}): Promise<Row | null> {
        const row = tables.membership.find((candidate) => matches(candidate, query.where));
        return row === undefined ? null : pick(row, query.select);
      },
    },
  };
}

export type MemoryPrisma = ReturnType<typeof memoryPrisma>;

export function emptyTables(): Tables {
  return { sourceWatch: [], sourceWatchVideo: [], repurposeRun: [], membership: [] };
}
