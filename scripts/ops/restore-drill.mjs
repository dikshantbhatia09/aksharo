#!/usr/bin/env node
/**
 * The local half of the quarterly restore drill (`05-system-architecture.md`
 * §10; `docs/runbooks/backup-restore.md` explains the split with the real,
 * staging-RDS drill in `docs/runbooks/restore-from-pitr.md`).
 *
 * Proves, against the `docker compose` Postgres container, that: a dump of a
 * real database restores cleanly into a scratch database, every migration in
 * `apps/api/prisma/migrations/` still applies to it in order, and the seed +
 * a handful of smoke queries succeed afterwards. Never touches the real
 * backup mechanism (RDS snapshots, S3/R2) and never runs `docker compose`
 * itself — it talks to the already-running `montaj-postgres` container
 * (`docker exec`), exactly like the brief's `docker exec montaj-postgres
 * psql ...` database-creation step.
 *
 *   node scripts/ops/restore-drill.mjs
 *   RESTORE_DRILL_SOURCE_URL=postgresql://... node scripts/ops/restore-drill.mjs
 *
 * Exit code 0 on success, non-zero (with the reason on stderr) otherwise, so
 * `.github/workflows/ops-restore-drill.yml` can gate on it.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const API_DIR = join(REPO_ROOT, "apps", "api");
const CONTAINER = process.env["RESTORE_DRILL_CONTAINER"] ?? "montaj-postgres";
const PG_USER = process.env["RESTORE_DRILL_PG_USER"] ?? "montaj";
const PG_HOST_PORT = process.env["RESTORE_DRILL_PG_PORT"] ?? "5432";
const SCRATCH_DB = process.env["RESTORE_DRILL_TARGET_DB"] ?? "montaj_restore_drill";
/**
 * `"docker"` (default): talk to the already-running `montaj-postgres` compose
 * container via `docker exec`, matching every other local-dev script in this
 * repo. `"tcp"`: call `pg_dump`/`psql`/`createdb`/`dropdb` directly against
 * `localhost:$RESTORE_DRILL_PG_PORT` with `PGPASSWORD` — for CI, where
 * Postgres is a GitHub Actions service container with no fixed name to `docker
 * exec` into but a real `postgresql-client` on the runner
 * (`.github/workflows/ops-restore-drill.yml`).
 */
const MODE = process.env["RESTORE_DRILL_MODE"] ?? "docker";
const PG_PASSWORD = process.env["RESTORE_DRILL_PG_PASSWORD"] ?? PG_USER;

const sourceUrl = process.env["RESTORE_DRILL_SOURCE_URL"] ?? process.env["DATABASE_URL"];
if (sourceUrl === undefined || sourceUrl === "") {
  fail("Set RESTORE_DRILL_SOURCE_URL or DATABASE_URL to the database to dump.");
}
const sourceDb = new URL(sourceUrl).pathname.replace(/^\//, "");
if (sourceDb === "") fail(`Could not read a database name out of ${sourceUrl}`);

/** Never restore over a database another agent's tests might be using. */
const PROTECTED = new Set(["montaj", "postgres", "template0", "template1"]);
if (PROTECTED.has(SCRATCH_DB)) {
  fail(`Refusing to use "${SCRATCH_DB}" as the scratch database (RESTORE_DRILL_TARGET_DB).`);
}

const steps = [];
const startedAt = Date.now();

function fail(message) {
  console.error(`[restore-drill] ${message}`);
  process.exit(1);
}

function step(name, fn) {
  const started = Date.now();
  console.log(`[restore-drill] ${name} ...`);
  fn();
  const ms = Date.now() - started;
  steps.push({ name, ms });
  console.log(`[restore-drill] ${name} — ${String(ms)}ms`);
}

/** Run a command, inheriting stdio, throwing with the command's own stderr on failure. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "pipe", encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed:\n${detail}`);
  }
  return result.stdout;
}

function dockerExec(args, options = {}) {
  return run(
    "docker",
    ["exec", ...(options.stdin === undefined ? [] : ["-i"]), CONTAINER, ...args],
    {
      input: options.stdin,
    },
  );
}

/** `pg_dump`/`psql`/`createdb`/`dropdb` directly against `localhost`, over TCP. */
function pgTcp(args, options = {}) {
  const [tool, ...rest] = args;
  return run(tool, ["-h", "localhost", "-p", PG_HOST_PORT, ...rest], {
    input: options.stdin,
    env: { ...process.env, PGPASSWORD: PG_PASSWORD },
  });
}

/** The one seam every step below calls through — `docker` or `tcp`, per {@link MODE}. */
function pg(args, options = {}) {
  return MODE === "tcp" ? pgTcp(args, options) : dockerExec(args, options);
}

const tmpDir = mkdtempSync(join(tmpdir(), "montaj-restore-drill-"));
const dumpPath = join(tmpDir, "dump.sql");

try {
  step(`dump "${sourceDb}"`, () => {
    const sql = pg(["pg_dump", "-U", PG_USER, "--no-owner", "--no-privileges", sourceDb]);
    writeFileSync(dumpPath, sql, "utf8");
    if (sql.trim() === "")
      throw new Error(`pg_dump of "${sourceDb}" produced no output — is the database empty?`);
  });

  step(`recreate scratch database "${SCRATCH_DB}"`, () => {
    // dropdb --if-exists so a drill re-run after a crash does not need manual cleanup.
    pg(["dropdb", "-U", PG_USER, "--if-exists", SCRATCH_DB]);
    pg(["createdb", "-U", PG_USER, SCRATCH_DB]);
  });

  step(`restore the dump into "${SCRATCH_DB}"`, () => {
    pg(["psql", "-v", "ON_ERROR_STOP=1", "-U", PG_USER, "-d", SCRATCH_DB], {
      stdin: readFileSync(dumpPath, "utf8"),
    });
  });

  const scratchUrl = `postgresql://${PG_USER}:${PG_USER}@localhost:${PG_HOST_PORT}/${SCRATCH_DB}?schema=public`;

  step("apply every migration (prisma migrate deploy)", () => {
    run("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: API_DIR,
      shell: true,
      env: { ...process.env, DATABASE_URL: scratchUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    });
  });

  step("seed smoke (pnpm db:seed against the scratch database)", () => {
    run("pnpm", ["exec", "tsx", "prisma/seed.ts"], {
      cwd: API_DIR,
      shell: true,
      env: { ...process.env, DATABASE_URL: scratchUrl },
    });
  });

  step("smoke queries", () => {
    const check = (table) => {
      const out = pg([
        "psql",
        "-U",
        PG_USER,
        "-d",
        SCRATCH_DB,
        "-t",
        "-A",
        "-c",
        `SELECT count(*) FROM ${table};`,
      ]).trim();
      const count = Number(out);
      if (!Number.isFinite(count) || count <= 0) {
        throw new Error(
          `Smoke query on "${table}" returned ${out} — expected at least one row after seeding.`,
        );
      }
      return count;
    };
    const counts = {
      users: check("users"),
      plans: check("plans"),
      style_presets: check("style_presets"),
    };
    console.log("[restore-drill] row counts:", counts);
  });
} catch (error) {
  console.error(
    `[restore-drill] FAILED: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
} finally {
  step(`drop scratch database "${SCRATCH_DB}"`, () => {
    pg(["dropdb", "-U", PG_USER, "--if-exists", SCRATCH_DB]);
  });
  rmSync(tmpDir, { recursive: true, force: true });
}

const totalMs = Date.now() - startedAt;
if (process.exitCode !== 1) {
  console.log(
    `[restore-drill] OK — ${String(steps.length)} steps, ${String(totalMs)}ms total. ` +
      steps.map((s) => `${s.name}=${String(s.ms)}ms`).join(", "),
  );
}
