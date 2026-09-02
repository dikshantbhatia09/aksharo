/**
 * One PostgreSQL and one Redis for the whole Vitest run (A23a).
 *
 * Before this file existed every Docker-backed suite started its own pair, so a
 * single `pnpm --filter @montaj/api test` asked Docker for eight containers and a
 * machine running several agents at once asked for thirty. Docker answered with
 * HTTP 500s and `beforeAll` timeouts, and the suites failed for reasons that had
 * nothing to do with the code under test.
 *
 * What happens here, once per run:
 *
 *   1. Resolve a PostgreSQL — `TEST_DATABASE_URL` if the developer or CI provided
 *      one, otherwise a single `pgvector/pgvector:pg16` container. The image
 *      matters: the schema has a `vector(512)` column, so stock `postgres:16`
 *      cannot run the first migration.
 *   2. Build `montaj_test_template` on it exactly the way `pnpm db:migrate` does —
 *      `prisma migrate deploy`, then `prisma/sql/`. A template built any other way
 *      would prove nothing about the command operators actually run. Guarded by an
 *      advisory lock and fingerprinted, so several runs can share one server and
 *      only the first pays for the migration.
 *   3. Resolve a Redis the same way, and ask it how many logical databases it has.
 *   4. Publish all of it to the workers with `provide()`; `test/suite-context.ts`
 *      turns it into one database, one logical Redis database and one queue prefix
 *      per suite.
 *
 * Nothing here fails a run because infrastructure is missing: an unreachable
 * Docker leaves a skip reason behind and the Docker-gated suites skip loudly, the
 * way they always have.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import Redis from "ioredis";
import { Client } from "pg";

import { databasePrefix, databaseUrlFor, redisDbPool, runStartedAt } from "./test-run.js";
import { applySql, listSqlFiles } from "../scripts/apply-sql.js";

import type { TestRunDatabase, TestRunInfo, TestRunRedis } from "./test-run.js";
import type { TestProject } from "vitest/node";

const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const REDIS_IMAGE = "redis:7-alpine";

/** Migrated once per run; every suite database is a copy of it. */
const TEMPLATE_DATABASE = "montaj_test_template";

/**
 * Logical databases the run's own Redis container is started with.
 *
 * Redis ships with 16. One per suite is what isolates the keys the product
 * hard-codes (`montaj:auth:*`, `montaj:rl:*`), and 32 leaves room for the suites
 * this package has yet to grow. Costs nothing: an empty logical database is a
 * pointer.
 */
const REDIS_DATABASES = 32;

/**
 * Suites take logical Redis databases from here upwards, so database 0 — where a
 * developer's own `docker compose` stack lives — is never touched by a test run.
 */
const FIRST_REDIS_DB = 1;

/**
 * How old a leftover suite database must be before the sweep takes it.
 *
 * An hour is four times the longest measured run of this suite, and the sweep has
 * a second gate — no open connections — so a live run is safe from it twice over.
 */
const STALE_DATABASE_AGE_MS = 60 * 60 * 1000;

/**
 * Ceiling on the wait for the template lock, in milliseconds.
 *
 * Long enough to sit out another agent's full `prisma migrate deploy`, short
 * enough that a lock nobody will release fails the run instead of hanging it.
 */
const TEMPLATE_LOCK_TIMEOUT_MS = 5 * 60_000;

/**
 * Ceilings on the sweep: one `DROP DATABASE`, and the sweep as a whole.
 *
 * The drops here are sequential and nothing races them, so they are far cheaper
 * than the ones a suite's `afterAll` attempts — but the checkpoint each one forces
 * was measured taking more than half a minute on a machine already running three
 * dozen containers, and neither one stuck drop nor a long queue of them may hold
 * the run open. Whatever is left is dropped by the next run's sweep.
 */
const SWEEP_DROP_TIMEOUT_MS = 60_000;
const SWEEP_TOTAL_BUDGET_MS = 150_000;

interface Stoppable {
  stop(): Promise<void>;
}

const started: Stoppable[] = [];

/* -------------------------------------------------------------------------- */
/* Docker                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Is a Docker daemon there?
 *
 * Sixty seconds, not twenty (raised in A05): `docker info` costs a second or two
 * idle and can take far longer while Docker Desktop is pulling images for
 * somebody else. A daemon that is genuinely absent still fails in milliseconds —
 * the shell reports "command not found" — so the longer budget is only ever spent
 * waiting for a daemon that IS there. A23a made this cheap: the probe used to run
 * once per suite, in parallel, on the same busy daemon; now it runs once per run.
 */
function probeDocker(): { available: boolean; reason: string } {
  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "pipe",
    shell: true,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (probe.status === 0) return { available: true, reason: "" };
  return {
    available: false,
    reason:
      probe.signal !== null || probe.status === null
        ? "docker did not answer within 60s (daemon busy or stopped)"
        : `docker is not available (${(probe.stderr ?? "").trim().slice(0, 200)})`,
  };
}

/* -------------------------------------------------------------------------- */
/* PostgreSQL                                                                  */
/* -------------------------------------------------------------------------- */

/** `prisma migrate deploy` against one URL — the same call `pnpm db:migrate` makes. */
function migrate(apiDir: string, url: string): void {
  const result = spawnSync("prisma", ["migrate", "deploy"], {
    cwd: apiDir,
    stdio: "pipe",
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * What the template is built from, as one hash.
 *
 * A template on a shared server outlives the run that built it, so it has to be
 * possible to tell a stale one from a current one. The migrations and the hand
 * SQL are the whole input to `pnpm db:migrate`, so hashing them answers exactly
 * the question "would rebuilding this change anything".
 */
function schemaFingerprint(apiDir: string): string {
  const hash = createHash("sha256");
  const migrations = resolve(apiDir, "prisma", "migrations");
  const dirs = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const dir of dirs) {
    hash.update(dir);
    hash.update(readFileSync(join(migrations, dir, "migration.sql"), "utf8"));
  }
  const sqlDir = resolve(apiDir, "prisma", "sql");
  for (const file of listSqlFiles(sqlDir)) {
    hash.update(file);
    hash.update(readFileSync(join(sqlDir, file), "utf8"));
  }
  return hash.digest("hex");
}

/** A 64-bit advisory-lock key from a name, as the string `pg` wants for a bigint. */
function advisoryKey(name: string): string {
  return createHash("sha256").update(name).digest().readBigInt64BE(0).toString();
}

async function withAdminClient<T>(
  adminUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(client: Client, name: string): Promise<boolean> {
  const rows = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  return rows.rowCount === 1;
}

/**
 * Build (or adopt) the template database.
 *
 * The advisory lock is what lets several agents point `TEST_DATABASE_URL` at one
 * server: the first run through migrates, the rest find a matching fingerprint and
 * skip straight to cloning. It is taken on the admin connection and released
 * before any suite runs, because `CREATE DATABASE … TEMPLATE` refuses while
 * another session is connected to the source.
 */
async function ensureTemplate(apiDir: string, adminUrl: string): Promise<void> {
  const fingerprint = schemaFingerprint(apiDir);
  const templateUrl = databaseUrlFor(adminUrl, TEMPLATE_DATABASE);

  await withAdminClient(adminUrl, async (admin) => {
    // The lock wait is where a second agent sits while the first one migrates, so
    // it needs a ceiling: a lock nobody will ever release must fail the run rather
    // than hang it. `statement_timeout` covers lock waits as well as queries.
    await admin.query(`SET statement_timeout = ${String(TEMPLATE_LOCK_TIMEOUT_MS)}`);
    await admin.query("SELECT pg_advisory_lock($1)", [advisoryKey(TEMPLATE_DATABASE)]);
    try {
      if (await databaseExists(admin, TEMPLATE_DATABASE)) {
        if (await templateMatches(templateUrl, fingerprint)) {
          console.warn(`[test-run] reusing ${TEMPLATE_DATABASE} (schema unchanged)`);
          return;
        }
        console.warn(`[test-run] ${TEMPLATE_DATABASE} is out of date — rebuilding`);
        await admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DATABASE}" WITH (FORCE)`);
      }

      await admin.query(`CREATE DATABASE "${TEMPLATE_DATABASE}"`);
      migrate(apiDir, templateUrl);
      await applySql(templateUrl, resolve(apiDir, "prisma", "sql"));
      await stampTemplate(templateUrl, fingerprint);
      console.warn(`[test-run] built ${TEMPLATE_DATABASE} (migrations + prisma/sql)`);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [advisoryKey(TEMPLATE_DATABASE)]);
    }
  });
}

async function templateMatches(templateUrl: string, fingerprint: string): Promise<boolean> {
  const client = new Client({ connectionString: templateUrl });
  await client.connect();
  try {
    const rows = await client.query<{ fingerprint: string }>(
      "SELECT fingerprint FROM _montaj_test_template LIMIT 1",
    );
    return rows.rows[0]?.fingerprint === fingerprint;
  } catch {
    // No stamp table: a template from before A23a, or a half-built one.
    return false;
  } finally {
    await client.end();
  }
}

async function stampTemplate(templateUrl: string, fingerprint: string): Promise<void> {
  const client = new Client({ connectionString: templateUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS _montaj_test_template (
         fingerprint text PRIMARY KEY,
         built_at    timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query("DELETE FROM _montaj_test_template");
    await client.query("INSERT INTO _montaj_test_template (fingerprint) VALUES ($1)", [
      fingerprint,
    ]);
  } finally {
    await client.end();
  }
}

/**
 * Drop suite databases an earlier run left behind — a crash, or a `DROP DATABASE`
 * that ran out of budget while the machine was busy.
 *
 * Two gates, because the server may be shared with other agents. The name carries
 * the run's start time, so anything younger than {@link STALE_DATABASE_AGE_MS} is
 * left alone; and a run that is still going holds Prisma's pool open, so anything
 * with a connection in `pg_stat_activity` is somebody's live suite whatever its
 * name says about its age.
 */
async function sweepStaleDatabases(adminUrl: string): Promise<number> {
  return withAdminClient(adminUrl, async (admin) => {
    const rows = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE 'montaj\\_t\\_%'
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
    );
    const cutoff = Date.now() - STALE_DATABASE_AGE_MS;
    const deadline = Date.now() + SWEEP_TOTAL_BUDGET_MS;
    await admin.query(`SET statement_timeout = ${String(SWEEP_DROP_TIMEOUT_MS)}`);
    let dropped = 0;
    for (const { datname } of rows.rows) {
      const startedAt = runStartedAt(datname);
      if (startedAt === null || startedAt.getTime() > cutoff) continue;
      if (Date.now() > deadline) break;
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
        dropped += 1;
      } catch {
        // Somebody else is using it, or dropped it first. Either is fine.
      }
    }
    return dropped;
  });
}

async function resolvePostgres(
  apiDir: string,
  docker: { available: boolean; reason: string },
): Promise<{ database: TestRunDatabase | null; reason: string; containers: number }> {
  if (process.env["MONTAJ_SKIP_DB_TESTS"] === "1") {
    return { database: null, reason: "MONTAJ_SKIP_DB_TESTS=1", containers: 0 };
  }

  const fromEnv = process.env["TEST_DATABASE_URL"];
  let adminUrl: string;
  let source: TestRunDatabase["source"];
  let containers = 0;

  if (fromEnv !== undefined && fromEnv !== "") {
    adminUrl = databaseUrlFor(fromEnv, "postgres");
    source = "env";
  } else if (!docker.available) {
    return { database: null, reason: docker.reason, containers: 0 };
  } else {
    try {
      const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
      const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
        .withDatabase("postgres")
        .withUsername("montaj")
        .withPassword("montaj")
        .withStartupTimeout(120_000)
        .start();
      started.push({
        stop: async () => {
          await container.stop();
        },
      });
      adminUrl = container.getConnectionUri();
      source = "testcontainers";
      containers = 1;
    } catch (error) {
      return {
        database: null,
        reason: error instanceof Error ? error.message : String(error),
        containers: 0,
      };
    }
  }

  // Deliberately NOT converted into a skip reason. "Docker is not running" is a
  // reason to skip; "there is a PostgreSQL and the schema would not build on it"
  // is a broken run, and a silently skipped integration suite is the worst
  // possible way to report that.
  await ensureTemplate(apiDir, adminUrl);

  try {
    const swept = await sweepStaleDatabases(adminUrl);
    if (swept > 0) console.warn(`[test-run] swept ${String(swept)} stale suite database(s)`);
  } catch (error) {
    console.warn(`[test-run] stale-database sweep skipped: ${String(error)}`);
  }

  return { database: { adminUrl, template: TEMPLATE_DATABASE, source }, reason: "", containers };
}

/* -------------------------------------------------------------------------- */
/* Redis                                                                       */
/* -------------------------------------------------------------------------- */

/** How many logical databases the server has; 16 is the Redis default. */
async function countRedisDatabases(url: string): Promise<number> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    lazyConnect: true,
  });
  try {
    await client.connect();
    const config = (await client.config("GET", "databases")) as unknown as string[];
    const value = Number(config[1]);
    return Number.isFinite(value) && value > 0 ? value : 16;
  } catch {
    return 16;
  } finally {
    client.disconnect();
  }
}

/** Connect and PING once, so an unreachable Redis becomes a skip reason, not a hang. */
async function redisReachable(url: string): Promise<boolean> {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    lazyConnect: true,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

/** The URL with its logical-database path removed, and the index it carried. */
function splitRedisUrl(url: string): { baseUrl: string; firstDb: number; pinned: boolean } {
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/^\//, "");
  const index = Number.parseInt(path, 10);
  const pinned = Number.isFinite(index) && path !== "";
  parsed.pathname = "";
  return { baseUrl: parsed.toString(), firstDb: pinned ? index : FIRST_REDIS_DB, pinned };
}

/**
 * The lowest logical database the run will claim.
 *
 * Leaving database 0 alone is a courtesy to whatever the developer has running on
 * the same Redis; giving every suite one of its own is a correctness requirement,
 * because two suites in one logical database sweep each other's `montaj:*` keys.
 * When the two conflict, correctness wins and the run takes database 0 as well —
 * loudly. A pinned index in the URL is an instruction and is never overridden.
 */
function chooseFirstDb(
  databases: number,
  firstDb: number,
  pinned: boolean,
  suiteCount: number,
): number {
  if (pinned || firstDb === 0) return firstDb;
  if (databases - firstDb >= suiteCount) return firstDb;
  console.warn(
    `[test-run] ${String(databases)} logical Redis databases for ${String(suiteCount)} e2e ` +
      "suites: claiming database 0 as well, so no two suites have to share one. Pin a database " +
      "in TEST_REDIS_URL (…/1) to forbid that, at the cost of two suites sharing.",
  );
  return 0;
}

async function resolveRedis(
  docker: { available: boolean; reason: string },
  suiteCount: number,
): Promise<{ redis: TestRunRedis | null; reason: string; containers: number }> {
  if (process.env["MONTAJ_SKIP_REDIS_TESTS"] === "1") {
    return { redis: null, reason: "MONTAJ_SKIP_REDIS_TESTS=1", containers: 0 };
  }

  const fromEnv = process.env["TEST_REDIS_URL"];
  if (fromEnv !== undefined && fromEnv !== "") {
    const { baseUrl, firstDb, pinned } = splitRedisUrl(fromEnv);
    if (!(await redisReachable(baseUrl))) {
      return { redis: null, reason: `TEST_REDIS_URL is not reachable (${baseUrl})`, containers: 0 };
    }
    const databases = await countRedisDatabases(baseUrl);
    return {
      redis: {
        baseUrl,
        firstDb: chooseFirstDb(databases, firstDb, pinned, suiteCount),
        databases,
        source: "env",
      },
      reason: "",
      containers: 0,
    };
  }

  if (docker.available) {
    try {
      const { GenericContainer } = await import("testcontainers");
      const container = await new GenericContainer(REDIS_IMAGE)
        .withExposedPorts(6379)
        // `noeviction` mirrors docker-compose.yml: BullMQ jobs must never be
        // evicted. The extra logical databases are what isolate the suites.
        .withCommand([
          "redis-server",
          "--databases",
          String(REDIS_DATABASES),
          "--maxmemory-policy",
          "noeviction",
        ])
        .withStartupTimeout(120_000)
        .start();
      started.push({
        stop: async () => {
          await container.stop();
        },
      });
      return {
        redis: {
          baseUrl: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
          firstDb: FIRST_REDIS_DB,
          databases: REDIS_DATABASES,
          source: "testcontainers",
        },
        reason: "",
        containers: 1,
      };
    } catch (error) {
      return {
        redis: null,
        reason: error instanceof Error ? error.message : String(error),
        containers: 0,
      };
    }
  }

  // No Docker: fall back to whatever `REDIS_URL` points at, which is how the
  // Redis-only suites ran before A23a on a machine with the compose stack up.
  const fallback = process.env["REDIS_URL"] ?? "redis://localhost:6379";
  const { baseUrl, firstDb, pinned } = splitRedisUrl(fallback);
  if (await redisReachable(baseUrl)) {
    const databases = await countRedisDatabases(baseUrl);
    return {
      redis: {
        baseUrl,
        firstDb: chooseFirstDb(databases, firstDb, pinned, suiteCount),
        databases,
        source: "env",
      },
      reason: "",
      containers: 0,
    };
  }
  return { redis: null, reason: docker.reason, containers: 0 };
}

/* -------------------------------------------------------------------------- */
/* Slots                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Positional arguments of the Vitest command line, which are its file filters.
 *
 * Used only to answer "does this run contain any e2e spec at all", so that
 * `vitest run src/one-unit.test.ts` does not start two containers to run nothing.
 * A value that belongs to a space-separated option (`--reporter default`) would be
 * mistaken for a filter here; that is why the caller falls back to starting the
 * infrastructure whenever the filtered glob comes back empty.
 */
function cliFileFilters(): string[] {
  return process.argv
    .slice(2)
    .filter((arg) => !arg.startsWith("-") && !["run", "watch", "related", "bench"].includes(arg));
}

/** `…/test/auth.e2e-spec.ts` -> `auth.e2e-spec`. */
function specName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).replace(/\.[cm]?[jt]sx?$/, "");
}

/**
 * A slot per e2e spec, from the sorted list of ALL of them.
 *
 * Derived from the whole package rather than the files being run so a suite keeps
 * its database name, its logical Redis database and its queue prefix whether it
 * runs alone or with thirteen others — which is what makes reproducing a parallel
 * failure with one `vitest run test/<file>` worth doing.
 */
function assignSlots(paths: readonly string[]): Record<string, number> {
  const names = paths
    .map(specName)
    .filter((name) => name.endsWith(".e2e-spec"))
    .sort((a, b) => a.localeCompare(b, "en"));
  const slots: Record<string, number> = {};
  names.forEach((name, index) => {
    slots[name] = index;
  });
  return slots;
}

/* -------------------------------------------------------------------------- */
/* Setup                                                                       */
/* -------------------------------------------------------------------------- */

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const apiDir = project.config.root;
  const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

  const all = await project.globTestFiles();
  const slots = assignSlots(all.testFiles);

  const filters = cliFileFilters();
  let wanted = all.testFiles;
  if (filters.length > 0) {
    const filtered = await project.globTestFiles(filters);
    if (filtered.testFiles.length > 0) wanted = filtered.testFiles;
  }
  const needsInfrastructure = wanted.some((path) => specName(path).endsWith(".e2e-spec"));

  if (!needsInfrastructure) {
    console.warn("[test-run] no e2e specs selected — no database or Redis started");
    project.provide("montajTestRun", {
      runId,
      database: null,
      databaseSkipReason: "no e2e specs selected",
      redis: null,
      redisSkipReason: "no e2e specs selected",
      slots,
      containersStarted: 0,
    } satisfies TestRunInfo);
    return async () => undefined;
  }

  const suiteCount = Object.keys(slots).length;
  const docker = probeDocker();
  const postgres = await resolvePostgres(apiDir, docker);
  const redis = await resolveRedis(docker, suiteCount);
  const containersStarted = postgres.containers + redis.containers;

  const redisPool = redis.redis === null ? 0 : redisDbPool(redis.redis).length;
  if (redis.redis !== null && redisPool < suiteCount) {
    console.warn(
      `[test-run] WARNING: ${String(suiteCount)} e2e suites but only ${String(redisPool)} ` +
        "logical Redis databases to hand out — some suites will share one, and a suite that " +
        "sweeps `montaj:*` will sweep its neighbour's keys too. Point TEST_REDIS_URL at a " +
        "lower database, or start Redis with a larger `--databases`.",
    );
  }

  const info: TestRunInfo = {
    runId,
    database: postgres.database,
    databaseSkipReason: postgres.reason,
    redis: redis.redis,
    redisSkipReason: redis.reason,
    slots,
    containersStarted,
  };
  project.provide("montajTestRun", info);

  console.warn(
    `[test-run] ${runId}: postgres ${summarise(postgres.database?.source, postgres.reason)}, ` +
      `redis ${summarise(redis.redis?.source, redis.reason)}, ` +
      `${String(containersStarted)} container(s) started for ${String(suiteCount)} e2e suite(s).`,
  );

  return async () => {
    if (postgres.database !== null) {
      await dropRunDatabases(postgres.database.adminUrl, runId);
    }
    for (const service of started.splice(0)) {
      await service.stop();
    }
  };
}

/** One half of the `[test-run]` line: where a service came from, or why it is missing. */
function summarise(source: string | undefined, reason: string): string {
  if (source === undefined) return `unavailable (${reason})`;
  return source === "env" ? "reused from the environment" : "container";
}

/** Drop whatever this run's suites did not drop themselves. */
async function dropRunDatabases(adminUrl: string, runId: string): Promise<void> {
  try {
    await withAdminClient(adminUrl, async (admin) => {
      const rows = await admin.query<{ datname: string }>(
        "SELECT datname FROM pg_database WHERE datname LIKE $1",
        [`${databasePrefix(runId)}%`],
      );
      await admin.query(`SET statement_timeout = ${String(SWEEP_DROP_TIMEOUT_MS)}`);
      const deadline = Date.now() + SWEEP_TOTAL_BUDGET_MS;
      let dropped = 0;
      let left = 0;
      for (const { datname } of rows.rows) {
        if (Date.now() > deadline) {
          left += 1;
          continue;
        }
        try {
          await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
          dropped += 1;
        } catch {
          left += 1;
        }
      }
      if (dropped > 0) {
        console.warn(`[test-run] dropped ${String(dropped)} leftover suite database(s)`);
      }
      if (left > 0) {
        console.warn(
          `[test-run] ${String(left)} suite database(s) were still busy; the next run sweeps them`,
        );
      }
    });
  } catch (error) {
    // The container may already be gone; a leaked database is swept next run.
    console.warn(`[test-run] could not sweep this run's databases: ${String(error)}`);
  }
}
