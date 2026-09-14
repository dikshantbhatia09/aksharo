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
import { PLAN_SEEDS, seedUlid } from "../prisma/seed-data.js";

import type { TestRunDatabase, TestRunInfo, TestRunRedis } from "./test-run.js";
import type { TestProject } from "vitest/node";

const POSTGRES_IMAGE = "pgvector/pgvector:pg16";
const REDIS_IMAGE = "redis:7-alpine";

/** Migrated once per run; every suite database is a copy of it. */
const TEMPLATE_PREFIX = "montaj_test_tpl";

/**
 * The template for one schema: `montaj_test_tpl_<first 12 hex of fingerprint>`.
 *
 * The name carries the schema because the server may not be ours. A23a used one
 * fixed `montaj_test_template` and rebuilt it — DROP, then CREATE — whenever the
 * fingerprint it found was not the one it wanted. On a laptop that is fine; on the
 * shared compose PostgreSQL, where several agents run this suite from different
 * branches, it meant one agent dropping the template another agent's suites were
 * still cloning from. The symptom is memorable: suites come up with an EMPTY
 * database and fail with "the table public.users does not exist", or with
 * "template database montaj_test_template does not exist" outright.
 *
 * Keyed by fingerprint, two branches with different migrations simply use
 * different templates, and a template is never dropped while anybody could want
 * it: a run either finds its own, stamped, and clones it, or builds it.
 */
function templateNameFor(fingerprint: string): string {
  return `${TEMPLATE_PREFIX}_${fingerprint.slice(0, 12)}`;
}

/** Templates older than this, with nothing connected, are swept. */
const STALE_TEMPLATE_AGE_MS = 24 * 60 * 60 * 1000;

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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  const dirs = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));
  for (const dir of dirs) {
    hash.update(dir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    hash.update(readFileSync(join(migrations, dir, "migration.sql"), "utf8"));
  }
  const sqlDir = resolve(apiDir, "prisma", "sql");
  for (const file of listSqlFiles(sqlDir)) {
    hash.update(file);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    hash.update(readFileSync(join(sqlDir, file), "utf8"));
  }
  // The plans are part of the template now (`seedPlans`), so a changed credit
  // grant or entitlement has to rebuild it. Without this a suite would quietly
  // clone a template carrying last week's numbers.
  hash.update(JSON.stringify(PLAN_SEEDS));
  return hash.digest("hex");
}

/**
 * Write the plan rows into the template.
 *
 * The template used to be migrations plus hand SQL and nothing else, which left
 * every cloned test database with an empty `plans` table. That was survivable
 * only while sign-up ignored entitlements: since `users.service.ts` provisions
 * the Free subscription and credit grant inside the sign-up transaction, a
 * database with no `free` plan makes `POST /auth/signup` fail closed with a 500
 * — which is the designed behaviour for an unseeded *production* database, and
 * simply wrong for a test fixture.
 *
 * Seeding here rather than in each harness mirrors what production actually
 * does: the migration job runs `db:migrate` and then `db:seed:reference`, so a
 * deployed database always has plans before it accepts a sign-up. A fixture
 * that does not is testing a state that cannot occur.
 *
 * Plans only, deliberately — not the system styles or feature flags the full
 * reference seed also writes. Those are slower to load and several suites
 * assert on how many exist, so they stay each suite's own business.
 *
 * Included in {@link schemaFingerprint}, so changing a plan rebuilds the
 * template rather than silently reusing one with the old numbers.
 */
async function seedPlans(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    for (const plan of PLAN_SEEDS) {
      await client.query(
        `INSERT INTO plans (id, key, name, prices, credits_per_month_tenths,
                            seat_price, entitlements, active, version,
                            created_at, updated_at)
         VALUES ($1, $2::"PlanKey", $3, $4::jsonb, $5, $6::jsonb, $7::jsonb, true, 1, now(), now())
         ON CONFLICT (key) DO NOTHING`,
        [
          seedUlid(`plan:${plan.key}`),
          plan.key,
          plan.name,
          JSON.stringify(plan.prices),
          plan.creditsPerMonthTenths,
          plan.seatPrice === null ? null : JSON.stringify(plan.seatPrice),
          JSON.stringify(plan.entitlements),
        ],
      );
    }
  } finally {
    await client.end();
  }
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
async function ensureTemplate(apiDir: string, adminUrl: string): Promise<string> {
  const fingerprint = schemaFingerprint(apiDir);
  const template = templateNameFor(fingerprint);
  const templateUrl = databaseUrlFor(adminUrl, template);

  await withAdminClient(adminUrl, async (admin) => {
    // The lock wait is where a second agent sits while the first one migrates, so
    // it needs a ceiling: a lock nobody will ever release must fail the run rather
    // than hang it. `statement_timeout` covers lock waits as well as queries.
    await admin.query(`SET statement_timeout = ${String(TEMPLATE_LOCK_TIMEOUT_MS)}`);
    await admin.query("SELECT pg_advisory_lock($1)", [advisoryKey(template)]);
    try {
      if (await databaseExists(admin, template)) {
        if (await templateMatches(templateUrl, fingerprint)) {
          console.warn(`[test-run] reusing ${template}`);
          return;
        }
        // Same fingerprint, no stamp: a build that died half way. Nobody can be
        // cloning it — a stamped template is never dropped — so finish the job.
        console.warn(`[test-run] ${template} was left half-built — rebuilding`);
        await admin.query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`);
      }

      await admin.query(`CREATE DATABASE "${template}"`);
      migrate(apiDir, templateUrl);
      await applySql(templateUrl, resolve(apiDir, "prisma", "sql"));
      await seedPlans(templateUrl);
      await stampTemplate(templateUrl, fingerprint);
      console.warn(`[test-run] built ${template} (migrations + prisma/sql + plans)`);
    } finally {
      await admin.query("SELECT pg_advisory_unlock($1)", [advisoryKey(template)]);
    }
  });

  return template;
}

/**
 * Drop templates for schemas nobody is using any more.
 *
 * A template per schema fingerprint means one more each time the migrations
 * change. They are small and cheap, but not free, so a run drops the ones that
 * are a day old, have nothing connected, and are not the one it just used.
 */
async function sweepStaleTemplates(adminUrl: string, keep: string): Promise<number> {
  return withAdminClient(adminUrl, async (admin) => {
    const rows = await admin.query<{ datname: string }>(
      `SELECT d.datname FROM pg_database d
        WHERE d.datname LIKE '${TEMPLATE_PREFIX}\\_%'
          AND d.datname <> $1
          AND NOT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE a.datname = d.datname)`,
      [keep],
    );
    const cutoff = Date.now() - STALE_TEMPLATE_AGE_MS;
    let dropped = 0;
    for (const { datname } of rows.rows) {
      const builtAt = await templateBuiltAt(databaseUrlFor(adminUrl, datname));
      if (builtAt === null || builtAt.getTime() > cutoff) continue;
      try {
        await admin.query(`SET statement_timeout = ${String(SWEEP_DROP_TIMEOUT_MS)}`);
        await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
        dropped += 1;
      } catch {
        // Somebody connected between the query and the drop. Next run gets it.
      }
    }
    return dropped;
  });
}

/** When a template was stamped, or `null` when it carries no stamp. */
async function templateBuiltAt(templateUrl: string): Promise<Date | null> {
  const client = new Client({ connectionString: templateUrl });
  try {
    await client.connect();
    const rows = await client.query<{ built_at: Date }>(
      "SELECT built_at FROM _montaj_test_template LIMIT 1",
    );
    return rows.rows[0]?.built_at ?? null;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
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
  const template = await ensureTemplate(apiDir, adminUrl);

  try {
    const swept = await sweepStaleDatabases(adminUrl);
    if (swept > 0) console.warn(`[test-run] swept ${String(swept)} stale suite database(s)`);
    const templates = await sweepStaleTemplates(adminUrl, template);
    if (templates > 0) console.warn(`[test-run] swept ${String(templates)} stale template(s)`);
  } catch (error) {
    console.warn(`[test-run] stale-database sweep skipped: ${String(error)}`);
  }

  return { database: { adminUrl, template, source }, reason: "", containers };
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
 * Since A23b this is only ever a courtesy. Isolation is the per-suite key prefix
 * (`MONTAJ_REDIS_PREFIX` and `MONTAJ_QUEUE_PREFIX`), which holds however few
 * logical databases there are; spreading the suites over the databases as well is
 * a second separator taken when it happens to be free, and leaving database 0
 * alone costs nothing now that sharing one is harmless. A pinned index in the URL
 * is an instruction and is never overridden.
 */
function chooseFirstDb(databases: number, firstDb: number, pinned: boolean): number {
  return pinned ? firstDb : Math.min(firstDb, Math.max(databases - 1, 0));
}

async function resolveRedis(docker: {
  available: boolean;
  reason: string;
}): Promise<{ redis: TestRunRedis | null; reason: string; containers: number }> {
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
        firstDb: chooseFirstDb(databases, firstDb, pinned),
        pinned,
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
          pinned: false,
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
        firstDb: chooseFirstDb(databases, firstDb, pinned),
        pinned,
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
 * Does this spec need the shared Postgres/Redis? Every `*.e2e-spec.ts` does, by
 * definition; B02's `*.property.spec.ts` needs it too — it runs the credits
 * ledger concurrency property test against a real database from its own vitest
 * config (`vitest.property.config.ts`), kept out of `vitest.config.ts`'s
 * `include` (and so out of `pnpm test`) precisely by NOT being named
 * `*.e2e-spec.ts` — but it still needs `global-setup.ts` to start the same
 * infrastructure and hand it a slot.
 */
function needsTestInfrastructure(name: string): boolean {
  return name.endsWith(".e2e-spec") || name.endsWith(".property.spec");
}

/**
 * A slot per e2e (or property) spec, from the sorted list of ALL of them.
 *
 * Derived from the whole package rather than the files being run so a suite keeps
 * its database name, its logical Redis database and its queue prefix whether it
 * runs alone or with thirteen others — which is what makes reproducing a parallel
 * failure with one `vitest run test/<file>` worth doing.
 */
function assignSlots(paths: readonly string[]): Record<string, number> {
  const names = paths
    .map(specName)
    .filter(needsTestInfrastructure)
    .sort((a, b) => a.localeCompare(b, "en"));
  const slots: Record<string, number> = {};
  names.forEach((name, index) => {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
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
  const needsInfrastructure = wanted.some((path) => needsTestInfrastructure(specName(path)));

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
  const redis = await resolveRedis(docker);
  const containersStarted = postgres.containers + redis.containers;

  // Not a warning any more. Since A23b the suites are separated by their key
  // prefixes, so sharing a logical database costs nothing but a shared `KEYS`
  // scan; the databases are a second separator taken when there are enough.
  const redisPool = redis.redis === null ? 0 : redisDbPool(redis.redis).length;
  if (redis.redis !== null && redisPool < suiteCount) {
    console.warn(
      `[test-run] ${String(suiteCount)} e2e suites over ${String(redisPool)} logical Redis ` +
        "database(s): some share one, and are kept apart by their key prefixes.",
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
