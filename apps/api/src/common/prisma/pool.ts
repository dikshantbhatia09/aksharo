/**
 * The database connection budget for one process.
 *
 * Prisma's default `connection_limit` is `numCpus * 2 + 1`, chosen per process
 * from whatever machine it happens to start on. That is a reasonable default for
 * one process on one laptop and a bad one for a fleet: the API is allowed up to
 * 12 replicas, realtime and the workers open their own pools, and none of them
 * knows about the others or about PostgreSQL's finite `max_connections`. Scaling
 * out under load — exactly when the autoscaler adds replicas — is therefore how
 * the database runs out of connections, and a connection-exhausted database
 * fails *every* request, not just the marginal one (launch-readiness P0-11).
 *
 * So the budget is stated, not inferred. `DATABASE_POOL_SIZE` is a per-process
 * number the operator derives from the worksheet in
 * `docs/runbooks/db-connection-budget.md`:
 *
 *   max_connections − reserved_for_admin_and_migrations
 *     ≥ Σ over components of (replicas × DATABASE_POOL_SIZE)
 *
 * It is a *local process setting* like `API_PORT` and `TRUST_PROXY`, not a
 * CONTRACTS §1 variable, because it describes this deployment's shape rather
 * than the application's interface.
 */

/**
 * Connections per process when `DATABASE_POOL_SIZE` says nothing.
 *
 * Deliberately a fixed number rather than a function of the host's CPU count:
 * the point is that the total is predictable from the replica count alone. Ten
 * is enough for an API pod serving a few hundred requests a second against
 * millisecond queries, and small enough that the documented maxima
 * (12 API + 8 realtime + workers) stay under a default `max_connections` of 100
 * with room reserved for migrations and an operator's psql.
 */
export const DEFAULT_POOL_SIZE = 10;

/**
 * Seconds a request waits for a free connection before failing.
 *
 * Failing fast matters more than queueing here: a request that waits 30 s for a
 * connection has already blown every latency budget, and the client has usually
 * retried — adding a second request to the same queue.
 */
export const DEFAULT_POOL_TIMEOUT_SEC = 10;

export interface PoolBudget {
  readonly connectionLimit: number;
  readonly poolTimeoutSec: number;
  /** True when the URL already carried a limit, which is then left alone. */
  readonly fromUrl: boolean;
}

/**
 * Apply the budget to a PostgreSQL connection URL.
 *
 * A `connection_limit` already present in `DATABASE_URL` always wins: an
 * operator who has tuned the URL by hand has made a more specific statement than
 * the environment default, and silently overriding it would make the effective
 * limit impossible to read off either place.
 */
export function applyPoolBudget(
  databaseUrl: string,
  source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): { readonly url: string; readonly budget: PoolBudget } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    // Not a URL we can parse — hand it back untouched and let Prisma produce the
    // error, which is more specific than anything this could say.
    return {
      url: databaseUrl,
      budget: {
        connectionLimit: DEFAULT_POOL_SIZE,
        poolTimeoutSec: DEFAULT_POOL_TIMEOUT_SEC,
        fromUrl: false,
      },
    };
  }

  const existing = url.searchParams.get("connection_limit");
  if (existing !== null && existing !== "") {
    const parsed = Number.parseInt(existing, 10);
    return {
      url: databaseUrl,
      budget: {
        connectionLimit: Number.isFinite(parsed) ? parsed : DEFAULT_POOL_SIZE,
        poolTimeoutSec: Number.parseInt(url.searchParams.get("pool_timeout") ?? "", 10) ||
          DEFAULT_POOL_TIMEOUT_SEC,
        fromUrl: true,
      },
    };
  }

  const connectionLimit = positiveIntOr(source["DATABASE_POOL_SIZE"], DEFAULT_POOL_SIZE);
  const poolTimeoutSec = positiveIntOr(source["DATABASE_POOL_TIMEOUT_SEC"], DEFAULT_POOL_TIMEOUT_SEC);

  url.searchParams.set("connection_limit", String(connectionLimit));
  url.searchParams.set("pool_timeout", String(poolTimeoutSec));

  return {
    url: url.toString(),
    budget: { connectionLimit, poolTimeoutSec, fromUrl: false },
  };
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
