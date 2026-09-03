/**
 * Node's built-in test runner (`pnpm test:scripts`), same as
 * `scripts/format-changed.test.mjs` — this is a plain script, not a workspace
 * package, so it is not covered by `pnpm -w test`.
 *
 * Only the parts that do not need a live compose stack: refusing a protected
 * database name, and failing loudly with no source configured. The actual
 * dump/restore/migrate/seed path is exercised for real by
 * `docs/runbooks/backup-restore.md`'s manual run and the CI job — a mocked
 * version of that path would only prove the mocks agree with each other.
 */
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./restore-drill.mjs", import.meta.url));

function runScript(env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return {
      status: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

test("refuses a protected target database", () => {
  const { status, output } = runScript({
    DATABASE_URL: "postgresql://montaj:montaj@localhost:5432/montaj_x04",
    RESTORE_DRILL_TARGET_DB: "montaj",
  });
  assert.notEqual(status, 0);
  assert.match(output, /Refusing to use "montaj"/);
});

test("fails loudly with neither RESTORE_DRILL_SOURCE_URL nor DATABASE_URL set", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.RESTORE_DRILL_SOURCE_URL;
  const { status, output } = runScript(env);
  assert.notEqual(status, 0);
  assert.match(output, /Set RESTORE_DRILL_SOURCE_URL or DATABASE_URL/);
});
