/**
 * Apply database migrations: `prisma migrate deploy`, then the hand-maintained DDL
 * in `prisma/sql/`.
 *
 * The two halves are one command on purpose. A database that has the Prisma tables
 * but not the CHECK constraints looks fine and quietly accepts a UPI mandate above
 * the RBI cap, so there is no state in which only the first half has run.
 *
 * Idempotent: `migrate deploy` skips migrations already in `_prisma_migrations`,
 * and every file in `prisma/sql/` is written to be re-runnable.
 *
 * Run with: pnpm --filter @montaj/api db:migrate
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { applySql } from "./apply-sql.js";
import { loadRepoDotenv } from "../src/config/dotenv.js";

const API_DIR = resolve(__dirname, "..");
const MIGRATIONS_DIR = resolve(API_DIR, "prisma", "migrations");

function hasMigrations(): boolean {
  if (!existsSync(MIGRATIONS_DIR)) return false;
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).some((entry) => entry.isDirectory());
}

async function main(): Promise<void> {
  loadRepoDotenv(API_DIR);

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("[db:migrate] DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  if (!hasMigrations()) {
    console.error("[db:migrate] prisma/migrations is empty — nothing to deploy.");
    process.exit(1);
  }

  const deploy = spawnSync("prisma", ["migrate", "deploy"], {
    cwd: API_DIR,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  if (deploy.status !== 0) process.exit(deploy.status ?? 1);

  const applied = await applySql(databaseUrl);
  for (const file of applied) {
    console.warn(`[db:migrate] ${file.changed ? "applied " : "verified"} sql/${file.filename}`);
  }
  console.warn(`[db:migrate] schema and ${applied.length} hand-SQL file(s) up to date.`);
}

main().catch((error: unknown) => {
  console.error(`[db:migrate] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
