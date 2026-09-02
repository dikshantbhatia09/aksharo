/**
 * What one Vitest run of this package shares, and how each suite carves its own
 * corner out of it (A23a).
 *
 * The rule the rest of the harness is built on: **infrastructure is started once
 * per RUN, and isolated per SUITE.** `test/global-setup.ts` starts at most one
 * PostgreSQL and one Redis (or reuses `TEST_DATABASE_URL` / `TEST_REDIS_URL`),
 * migrates a single template database, and publishes the result through Vitest's
 * `provide()`/`inject()` channel as {@link TestRunInfo}. Every suite then:
 *
 *   * clones the template into its own database (`CREATE DATABASE … TEMPLATE …`),
 *     dropped when the suite finishes — so two suites can `TRUNCATE` the same
 *     table at the same instant and never see each other;
 *   * takes one logical Redis database of its own, which is what isolates the
 *     hard-coded keys the product writes (`montaj:auth:*`, `montaj:rl:*`);
 *   * takes its own `MONTAJ_QUEUE_PREFIX`, which is what isolates every BullMQ
 *     structure and every realtime pub/sub channel — pub/sub is NOT scoped by the
 *     logical database, so the prefix is the only thing standing between two
 *     concurrent runs there.
 *
 * This file holds the contract and the naming arithmetic only. It must stay free
 * of `vitest` imports: `global-setup.ts` runs in Vitest's main process, where the
 * runner API (`expect`, `inject`) does not exist. The worker-side accessors live
 * in `test/suite-context.ts`.
 */
import { createHash } from "node:crypto";

/** Where a service came from, for the console line and the report. */
export type TestServiceSource = "env" | "testcontainers";

export interface TestRunDatabase {
  /** A URL on the same server pointed at `postgres`; used for CREATE/DROP DATABASE. */
  readonly adminUrl: string;
  /** Migrated once per run; every suite database is a copy of this one. */
  readonly template: string;
  readonly source: TestServiceSource;
}

export interface TestRunRedis {
  /** Base URL with no logical-database path; suites append their own index. */
  readonly baseUrl: string;
  /** Logical database index the first slot is given (see {@link redisDbForSlot}). */
  readonly firstDb: number;
  /**
   * The URL named a logical database, so every suite uses that one.
   *
   * `TEST_REDIS_URL=redis://…/0` is an instruction, not a starting point: it says
   * "this database", and since A23b the suites are separated by their key
   * prefixes, so obeying it costs nothing. It is also how the whole suite is
   * verified against a single logical database.
   */
  readonly pinned: boolean;
  /** How many logical databases the server has (`CONFIG GET databases`). */
  readonly databases: number;
  readonly source: TestServiceSource;
}

/** Everything `global-setup.ts` publishes to the workers. */
export interface TestRunInfo {
  /** Unique per Vitest run; the prefix of every name this run creates. */
  readonly runId: string;
  /** `null` when no PostgreSQL could be reached — suites skip. */
  readonly database: TestRunDatabase | null;
  /** Why {@link database} is `null`. Empty when it is not. */
  readonly databaseSkipReason: string;
  /** `null` when no Redis could be reached — suites skip. */
  readonly redis: TestRunRedis | null;
  /** Why {@link redis} is `null`. Empty when it is not. */
  readonly redisSkipReason: string;
  /**
   * Spec file name (basename, no extension) to slot number.
   *
   * Assigned from the sorted list of every `*.e2e-spec.ts` in the package, not
   * from the subset being run, so a suite keeps the same slot whether it runs
   * alone or with the others — which makes a failure reproducible.
   */
  readonly slots: Readonly<Record<string, number>>;
  /** 0, 1 or 2. The number this work package exists to hold down. */
  readonly containersStarted: number;
}

declare module "vitest" {
  interface ProvidedContext {
    montajTestRun: TestRunInfo;
  }
}

/** Longest identifier PostgreSQL will accept (`NAMEDATALEN` - 1). */
const PG_NAME_MAX = 63;

/** `auth.e2e-spec` -> `auth_e2e_spec`, and nothing a quoted identifier dislikes. */
export function suiteSlug(specName: string): string {
  const slug = specName
    .toLowerCase()
    .replace(/\.e2e-spec$/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug === "" ? "suite" : slug;
}

/**
 * A stable slot for a spec file that `global-setup.ts` did not enumerate.
 *
 * Only reachable when a spec lives outside the glob (or Vitest could not report
 * the file name); a hash keeps two such files apart far more often than a
 * constant would, and the run id keeps them apart from everybody else.
 */
export function fallbackSlot(specName: string): number {
  const digest = createHash("sha256").update(specName).digest();
  return digest.readUInt16BE(0);
}

/**
 * The database one suite runs against: `montaj_t_<runId>_<slug>`.
 *
 * `attempt` disambiguates a suite that builds two databases in one file. Truncated
 * from the LEFT of the slug so the run id — the part the teardown sweep matches
 * on — always survives.
 */
export function suiteDatabaseName(runId: string, specName: string, attempt = 0): string {
  const prefix = `${databasePrefix(runId)}_`;
  const suffix = attempt === 0 ? "" : `_${String(attempt)}`;
  const room = PG_NAME_MAX - prefix.length - suffix.length;
  return `${prefix}${suiteSlug(specName).slice(0, Math.max(room, 1))}${suffix}`;
}

/** Every database this run creates starts with this. Used by the teardown sweep. */
export function databasePrefix(runId: string): string {
  return `montaj_t_${runId}`;
}

/** `montaj_t_<runId>_…` -> the run's start time, or `null` when unparseable. */
export function runStartedAt(databaseName: string): Date | null {
  const match = /^montaj_t_([0-9a-z]{8})[0-9a-f]{4}_/.exec(databaseName);
  if (match?.[1] === undefined) return null;
  const millis = Number.parseInt(match[1], 36);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis) : null;
}

/** Swap the database out of a PostgreSQL URL, keeping user, host and query. */
export function databaseUrlFor(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * The logical Redis databases a run may claim, in the order slots take them.
 *
 * Two rules, and both exist to keep a test run out of somebody else's data:
 *
 *   * start at `firstDb` and go up. Point `TEST_REDIS_URL` at `…/9` and the run
 *     uses 9, 10, 11 … first, so the databases below 9 stay untouched for as long
 *     as there are suites to fit above it.
 *   * never hand out database 0 unless `firstDb` is 0. Nothing else in this
 *     repository writes to a numbered database, so 0 is where a developer's own
 *     `docker compose` stack — and `pnpm dev` — keeps its keys.
 *
 * Wrapping round the pool is possible in principle (more suites than databases);
 * `global-setup.ts` warns when it would happen rather than failing the run.
 */
export function redisDbPool(redis: TestRunRedis): readonly number[] {
  if (redis.pinned) return [redis.firstDb];
  const total = redis.databases;
  if (total <= 1) return [0];
  const first = Math.min(Math.max(redis.firstDb, 0), total - 1);
  const pool: number[] = [];
  for (let db = first; db < total; db += 1) pool.push(db);
  for (let db = first === 0 ? 0 : 1; db < first; db += 1) pool.push(db);
  return pool;
}

/** Which logical Redis database a slot gets. */
export function redisDbForSlot(redis: TestRunRedis, slot: number): number {
  if (redis.pinned) return redis.firstDb;
  const pool = redisDbPool(redis);
  return pool[slot % pool.length] ?? 0;
}

/** The suite's Redis URL: the run's server, the suite's logical database. */
export function redisUrlForSlot(redis: TestRunRedis, slot: number): string {
  const url = new URL(redis.baseUrl);
  url.pathname = `/${String(redisDbForSlot(redis, slot))}`;
  return url.toString();
}

/**
 * The suite's BullMQ / realtime key prefix.
 *
 * Carries the run id as well as the slot because Redis pub/sub ignores the logical
 * database: two agents running suites against one Redis would otherwise deliver
 * each other's realtime frames.
 */
export function queuePrefixForSlot(runId: string, slot: number): string {
  return `montaj-test-${runId}-${String(slot)}`;
}
