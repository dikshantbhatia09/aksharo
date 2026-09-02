/**
 * A migrated PostgreSQL for one integration suite.
 *
 * Since A23a there is exactly ONE PostgreSQL per Vitest run — `test/global-setup.ts`
 * either reuses `TEST_DATABASE_URL` or starts a single `pgvector/pgvector:pg16`
 * container — and it carries a `montaj_test_template` database built by the same
 * code path `pnpm db:migrate` uses: `prisma migrate deploy`, then `prisma/sql/`.
 *
 * What this file does is hand each suite a private COPY of that template:
 *
 *     CREATE DATABASE "montaj_t_<runId>_<suite>" TEMPLATE "montaj_test_template"
 *
 * which PostgreSQL performs as a file copy, so it costs a fraction of a second
 * rather than the twenty a migration run costs — and, far more importantly, means
 * a suite can `TRUNCATE` any table it likes while thirteen other suites do the
 * same, with no interference. `stop()` drops the copy; `global-setup.ts` sweeps
 * whatever a crash left behind.
 *
 * When no PostgreSQL can be reached the suite skips with a loud message rather
 * than failing, so a laptop with Docker stopped can still run the unit tests.
 */
import { PrismaClient } from "@prisma/client";
import { Client } from "pg";

import { suiteName, testRun } from "./suite-context.js";
import { databaseUrlFor, suiteDatabaseName } from "./test-run.js";

export interface TestDatabase {
  readonly url: string;
  readonly prisma: PrismaClient;
  readonly source: "env" | "testcontainers";
  stop(): Promise<void>;
}

/** Why the suite was skipped, for the console message. */
export let skipReason = "";

/** Databases this worker has already created, so a second call gets a new name. */
let created = 0;

/**
 * PostgreSQL refuses to copy a template another session is connected to, and two
 * suites cloning at the same instant can collide. Both are transient, so retry.
 */
const CLONE_RETRY_BUDGET_MS = 60_000;
const CLONE_RETRY_DELAY_MS = 250;

/**
 * How long `afterAll` will wait for `DROP DATABASE` before handing it on.
 *
 * `DROP DATABASE` forces an immediate checkpoint and waits for it. That is tens of
 * milliseconds on an idle server and was measured at eleven seconds with two
 * suites dropping at once on a laptop already running thirty containers — and
 * fifteen suites finishing together would be far worse. A suite must never fail
 * because the checkpointer was busy, so the wait is bounded: whatever is still
 * dropping when the budget runs out is finished by the run teardown in
 * `global-setup.ts`, which sweeps sequentially with nothing racing it.
 *
 * The cancellation is safe. PostgreSQL removes the database's files only after the
 * checkpoint it is waiting on, so a statement cancelled during that wait leaves the
 * database exactly as it was — present, and there to be dropped again.
 */
const DROP_BUDGET_MS = 15_000;

/**
 * Can the integration suite run at all?
 *
 * Answered SYNCHRONOUSLY, because `describe.skipIf` is evaluated while the file is
 * collected and this package compiles to CommonJS (no top-level await). Before
 * A23a that meant every suite shelled out to `docker info` in parallel, on the
 * very daemon they were all about to overload; now `global-setup.ts` has already
 * answered the question once for the whole run and this is a property read.
 */
export function isDatabaseAvailable(): boolean {
  const run = testRun();
  if (run === null) {
    skipReason = "vitest globalSetup did not run (test/global-setup.ts)";
    return false;
  }
  if (run.database === null) {
    skipReason = run.databaseSkipReason;
    return false;
  }
  skipReason = "";
  return true;
}

/** Transient enough to be worth waiting out: the template is momentarily busy. */
function isTransientCloneError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "55006" || code === "57P03") return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("being accessed by other users");
}

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function cloneTemplate(adminUrl: string, template: string, name: string): Promise<void> {
  const deadline = Date.now() + CLONE_RETRY_BUDGET_MS;
  for (;;) {
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
      return;
    } catch (error) {
      if (!isTransientCloneError(error) || Date.now() > deadline) throw error;
    } finally {
      await admin.end();
    }
    // Jitter, so two suites that collided do not collide again on the retry.
    await sleep(CLONE_RETRY_DELAY_MS + Math.floor(Math.random() * CLONE_RETRY_DELAY_MS));
  }
}

/** `true` when the database is gone, `false` when the budget ran out first. */
async function dropDatabase(adminUrl: string, name: string, budgetMs: number): Promise<boolean> {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`SET statement_timeout = ${String(budgetMs)}`);
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    return true;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "57014") return false;
    throw error;
  } finally {
    await admin.end();
  }
}

/**
 * This suite's own copy of the migrated template, or `null` when unavailable.
 *
 * The signature is the one every spec has always called; only what happens inside
 * changed.
 */
export async function createTestDatabase(): Promise<TestDatabase | null> {
  const run = testRun();
  if (run?.database == null) {
    skipReason = run?.databaseSkipReason ?? "vitest globalSetup did not run";
    return null;
  }

  const { adminUrl, template, source } = run.database;
  const name = suiteDatabaseName(run.runId, suiteName(), created);
  created += 1;

  try {
    await cloneTemplate(adminUrl, template, name);
  } catch (error) {
    skipReason = error instanceof Error ? error.message : String(error);
    return null;
  }

  const url = databaseUrlFor(adminUrl, name);
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  return {
    url,
    prisma,
    source,
    stop: async () => {
      await prisma.$disconnect();
      if (!(await dropDatabase(adminUrl, name, DROP_BUDGET_MS))) {
        console.warn(`[test-run] ${name} is still busy; the run teardown will drop it`);
      }
    },
  };
}
