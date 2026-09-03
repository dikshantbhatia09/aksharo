/**
 * M19: parse the Postgres database name out of a `DATABASE_URL` connection
 * string, so scripts that shell out to `docker exec psql` target whichever
 * database the loaded `.env` actually points at instead of a hardcoded name
 * (M15's `scripts/local-ai-smoke.mjs` hardcoded `montaj_m15`, so a run from
 * a different worktree seeded credits into the wrong database and hit an FK
 * violation on `credit_accounts.workspace_id`).
 *
 * Accepts the standard `postgresql://user:pass@host:port/dbname?query`
 * form (also `postgres://`). Throws a clear error if `url` is falsy/empty
 * or has no path segment to use as a database name.
 */
export function parseDatabaseName(url) {
  if (!url || typeof url !== "string" || url.trim() === "") {
    throw new Error(
      "DATABASE_URL is not set — cannot determine which database to target. " +
        "Set DATABASE_URL in the loaded .env (see docs/models/LOCAL-MODELS.md).",
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`DATABASE_URL is not a valid URL: ${url} (${error.message})`);
  }
  const dbName = parsed.pathname.replace(/^\//, "");
  if (dbName === "") {
    throw new Error(`DATABASE_URL has no database name in its path: ${url}`);
  }
  return dbName;
}
