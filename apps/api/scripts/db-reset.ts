/**
 * Drop the database, re-apply every migration and the hand SQL, then seed.
 *
 * `prisma migrate reset` is invoked with `--skip-seed` and the seed is run at the
 * end instead: seeding before `prisma/sql/` has been applied would insert rows
 * without the CHECK constraints in place, which is precisely the state the
 * constraints exist to prevent.
 *
 * DESTRUCTIVE. Refuses to touch anything that does not look like a local
 * development database unless `MONTAJ_ALLOW_REMOTE_RESET=1` is set.
 *
 * NOTE for AI coding agents: Prisma 6.19 refuses `migrate reset` when it detects
 * it was invoked by an agent, and demands `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_
 * ACTION` carrying the human's own words of consent. That guard is correct and
 * must not be worked around — ask the operator to run this command themselves.
 * `db:migrate` and `db:seed` are unaffected.
 *
 * Run with: pnpm --filter @montaj/api db:reset
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { loadRepoDotenv } from "../src/config/dotenv.js";

const API_DIR = resolve(__dirname, "..");
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "host.docker.internal"]);

function assertLocal(databaseUrl: string): void {
  if (process.env["MONTAJ_ALLOW_REMOTE_RESET"] === "1") return;
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    host = "";
  }
  if (!LOCAL_HOSTS.has(host)) {
    console.error(
      `[db:reset] refusing to reset a non-local database (host "${host}").\n` +
        "Set MONTAJ_ALLOW_REMOTE_RESET=1 if you really mean it.",
    );
    process.exit(1);
  }
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, {
    cwd: API_DIR,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

loadRepoDotenv(API_DIR);

const databaseUrl = process.env["DATABASE_URL"];
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("[db:reset] DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}
assertLocal(databaseUrl);

run("prisma", ["migrate", "reset", "--force", "--skip-seed", "--skip-generate"]);
run("pnpm", ["db:migrate"]);
run("pnpm", ["db:seed"]);

console.warn("[db:reset] database reset, migrated and seeded.");
