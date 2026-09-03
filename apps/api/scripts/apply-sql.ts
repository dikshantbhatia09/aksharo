/**
 * Apply the hand-maintained DDL in `prisma/sql/` (see that folder's README).
 *
 * Runs after `prisma migrate deploy`, because every object in there hangs off a
 * table Prisma created. Each file is required to be idempotent, so the runner
 * re-applies all of them every time rather than skipping ones it has seen: that
 * turns "the index was dropped by hand in staging" from a silent performance cliff
 * into a self-healing no-op. `_montaj_sql_applied` records what ran and with which
 * checksum, purely so drift is visible in the database itself.
 *
 * Files are sent through `pg` and not Prisma's `$executeRawUnsafe` because they
 * contain `DO $$ ... $$` blocks and several statements per file, which the simple
 * query protocol handles and prepared statements do not.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { Client } from "pg";

const SQL_DIR = resolve(__dirname, "..", "prisma", "sql");

const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS _montaj_sql_applied (
  filename    text PRIMARY KEY,
  checksum    text        NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
)`;

export interface AppliedFile {
  readonly filename: string;
  readonly checksum: string;
  readonly changed: boolean;
}

/** `.sql` files in `prisma/sql/`, in lexical (zero-padded) order. */
export function listSqlFiles(dir: string = SQL_DIR): string[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

export function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Apply every file to `databaseUrl`. Each file runs inside its own transaction, so
 * a failure half-way leaves the earlier files applied and this one untouched.
 */
export async function applySql(databaseUrl: string, dir: string = SQL_DIR): Promise<AppliedFile[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: AppliedFile[] = [];

  try {
    await client.query(LEDGER_DDL);

    const previous = new Map<string, string>();
    const rows = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM _montaj_sql_applied",
    );
    for (const row of rows.rows) previous.set(row.filename, row.checksum);

    for (const filename of listSqlFiles(dir)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
      const contents = readFileSync(join(dir, filename), "utf8");
      const sum = checksum(contents);

      await client.query("BEGIN");
      try {
        await client.query(contents);
        await client.query(
          `INSERT INTO _montaj_sql_applied (filename, checksum, applied_at)
           VALUES ($1, $2, now())
           ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [filename, sum],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${filename}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }

      applied.push({ filename, checksum: sum, changed: previous.get(filename) !== sum });
    }
  } finally {
    await client.end();
  }

  return applied;
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error("[db:sql] DATABASE_URL is not set. Copy .env.example to .env first.");
    process.exit(1);
  }

  const applied = await applySql(databaseUrl);
  for (const file of applied) {
    console.warn(`[db:sql] ${file.changed ? "applied " : "verified"} ${file.filename}`);
  }
  console.warn(`[db:sql] ${applied.length} file(s) up to date.`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[db:sql] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
