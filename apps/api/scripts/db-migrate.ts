/**
 * Apply database migrations.
 *
 * A01 has no migrations (A03 designs the schema), so this is a guard rather than
 * a no-op alias: it runs `prisma migrate deploy` once `prisma/migrations` exists
 * and exits 0 with an explanation until then, which keeps `pnpm db:migrate` in
 * the wave verification gate green without pretending work happened.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATIONS_DIR = resolve(process.cwd(), "prisma", "migrations");

function hasMigrations(): boolean {
  if (!existsSync(MIGRATIONS_DIR)) return false;
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).some((entry) => entry.isDirectory());
}

if (!hasMigrations()) {
  console.warn("[db:migrate] no migrations yet — the schema lands in A03 (see docs/PLAN.md).");
  process.exit(0);
}

if (process.env["DATABASE_URL"] === undefined || process.env["DATABASE_URL"] === "") {
  console.error("[db:migrate] DATABASE_URL is not set. Copy .env.example to .env first.");
  process.exit(1);
}

const result = spawnSync("prisma", ["migrate", "deploy"], { stdio: "inherit", shell: true });
process.exit(result.status ?? 1);
