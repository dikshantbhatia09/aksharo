-- 0005 — A08b: dead-letter indexes, and the `jobKey` uniqueness A08 got wrong.
--
-- Everything here is a PARTIAL index, which is why it is not in `schema.prisma`.
-- Idempotent, like every file in this folder: `pnpm db:migrate` re-applies it on
-- every run.

-- ---------------------------------------------------------------------------
-- One live job per (workspace, jobKey).
--
-- A08's `jobs_live_job_key_key` is `UNIQUE (job_key) WHERE status IN
-- ('queued','running')` — no workspace column. That is stricter than the contract
-- and wrong in the one way that matters: CONTRACTS §3 scopes `jobKey` to a
-- workspace ("one live job per (workspace, unit of work)"), and job keys are
-- built from ids that are unique per workspace but from stable *prefixes* that are
-- not, so two tenants transcribing at the same time would collide and the second
-- enqueue would fail with a unique violation it could not explain.
--
-- Dropping and recreating rather than editing 0002: an applied file is never
-- edited (prisma/sql/README.md), and both statements are idempotent.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS jobs_live_job_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_live_workspace_job_key_key
  ON jobs (workspace_id, job_key)
  WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Dead-letter queue.
--
-- The admin console and `tools/runbooks/dlq-replay.js` both read one slice:
-- pending rows, newest first, usually filtered by queue. `dlq (queue, status,
-- failed_at)` in schema.prisma covers the filtered read; this covers the depth
-- gauge and the unfiltered "what is waiting for me" list, and stays small because
-- resolved rows — which are the vast majority once an incident is worked through —
-- are not in it.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS dlq_pending_idx
  ON dlq (queue, failed_at)
  WHERE status = 'pending';

-- The `jobs.dlq` marker is a needle in the jobs table; only the true rows are
-- ever selected on it.
CREATE INDEX IF NOT EXISTS jobs_dlq_idx
  ON jobs (type, dlq_at)
  WHERE dlq = true;

-- ---------------------------------------------------------------------------
-- Job-event retention (D47, 30 days).
--
-- The sweep is `DELETE FROM job_events WHERE at < now() - interval '30 days'`
-- in batches; `job_events (at)` from schema.prisma already serves it. What is
-- added here is the documentation of the rule next to the data, in the same
-- style as 0004-comments.sql.
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN job_events.data IS
  'Retention 30 days (D47). Every row carries data.retainUntil, written by JobEventsService; the jobs.event-retention sweep deletes on it and falls back to at < now() - 30 days for rows written before the marker existed.';

COMMENT ON TABLE dlq IS
  'Dead-lettered job attempts (A08b, D46). Never purged: once resolved it is the record of what the system could not do. See docs/runbooks/dlq-replay.md.';

COMMENT ON COLUMN jobs.attempt_no IS
  'Ordinal of jobs.attempt_id, 1-based. An admin replay increments it and mints a new attempt ULID.';
