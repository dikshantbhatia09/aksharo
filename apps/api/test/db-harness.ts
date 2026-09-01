/**
 * A migrated PostgreSQL for the integration suite.
 *
 * Resolution order:
 *   1. `TEST_DATABASE_URL` — a database the developer or CI has already provided.
 *   2. A testcontainers `pgvector/pgvector:pg16` container. The image matters: the
 *      schema has a `vector(512)` column, so stock `postgres:16` cannot run the
 *      first migration.
 *   3. Nothing — the suite skips with a loud message rather than failing, so a
 *      laptop with Docker stopped can still run the unit tests.
 *
 * Whichever source wins, the SAME code path builds it that `pnpm db:migrate` uses:
 * `prisma migrate deploy` followed by `prisma/sql/`. A test that built the schema
 * some other way would prove nothing about the command operators actually run.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { PrismaClient } from "@prisma/client";

import { applySql } from "../scripts/apply-sql.js";

const API_DIR = resolve(__dirname, "..");

export interface TestDatabase {
  readonly url: string;
  readonly prisma: PrismaClient;
  readonly source: "env" | "testcontainers";
  stop(): Promise<void>;
}

/** Why the suite was skipped, for the console message. */
export let skipReason = "";

/**
 * Can the integration suite run at all?
 *
 * Answered SYNCHRONOUSLY, because `describe.skipIf` is evaluated while the file is
 * collected and this package compiles to CommonJS (no top-level await). Starting
 * the container itself still happens in `beforeAll`.
 */
export function isDatabaseAvailable(): boolean {
  const fromEnv = process.env["TEST_DATABASE_URL"];
  if (fromEnv !== undefined && fromEnv !== "") return true;
  if (process.env["MONTAJ_SKIP_DB_TESTS"] === "1") {
    skipReason = "MONTAJ_SKIP_DB_TESTS=1";
    return false;
  }

  const probe = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    stdio: "pipe",
    shell: true,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (probe.status === 0) return true;

  skipReason = `docker is not available (${(probe.stderr ?? "").trim().slice(0, 200)})`;
  return false;
}

function migrate(url: string): void {
  const result = spawnSync("prisma", ["migrate", "deploy"], {
    cwd: API_DIR,
    stdio: "pipe",
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
  });
  if (result.status !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${result.stdout}\n${result.stderr}`);
  }
}

/** A database with the schema and the hand SQL applied, or `null` when unavailable. */
export async function createTestDatabase(): Promise<TestDatabase | null> {
  const fromEnv = process.env["TEST_DATABASE_URL"];

  if (fromEnv !== undefined && fromEnv !== "") {
    migrate(fromEnv);
    await applySql(fromEnv);
    const prisma = new PrismaClient({ datasources: { db: { url: fromEnv } } });
    return {
      url: fromEnv,
      prisma,
      source: "env",
      stop: async () => {
        await prisma.$disconnect();
      },
    };
  }

  try {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");

    const container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
      .withDatabase("montaj_test")
      .withUsername("montaj")
      .withPassword("montaj")
      .withStartupTimeout(120_000)
      .start();

    const url = container.getConnectionUri();
    migrate(url);
    await applySql(url);
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    return {
      url,
      prisma,
      source: "testcontainers",
      stop: async () => {
        await prisma.$disconnect();
        await container.stop();
      },
    };
  } catch (error) {
    skipReason = error instanceof Error ? error.message : String(error);
    return null;
  }
}
