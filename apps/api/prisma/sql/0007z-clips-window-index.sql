-- Clips on long videos (2026-09-27): one live run per workspace, source AND
-- window start.
--
-- `repurpose_runs_live_source_idx` (0008) made pasting the same link twice one
-- request. A run now processes a window of a long video, and "process the next
-- 20 minutes" is a second run of the same source that has to be able to run
-- while the first is still open - so the window start joins the key. Runs that
-- asked for no start share -1 and still collide exactly as before.
--
-- A partial index with an expression key, so it lives here and not in
-- `schema.prisma` or a Prisma migration (README "Where an index belongs"); the
-- column it reads comes from `migrations/20260927090000_clips_windows`, which
-- `prisma migrate deploy` has applied before any file here runs.
--
-- Named to sort BEFORE 0008 (`listSqlFiles` orders with `localeCompare("en")`,
-- which puts `0007z-` between `0007-` and `0008-`), and that is the point of the
-- name: 0008 re-runs `CREATE UNIQUE INDEX IF NOT EXISTS` with the OLD, stricter
-- key on every `db:migrate`. With the index missing (a fresh database, one
-- dropped by hand, one a scaffolded migration dropped) and two live windows of
-- one video in the table, that statement does not merely bring the old rule
-- back - it fails on the duplicate keys, and `db:migrate` stops there, before
-- any later file could repair it. Run first, this leaves 0008 an index of that
-- name to find and skip, on every path.
--
-- Idempotent: a definition that already has the window start is left alone;
-- one without it (0008's, from before this file) is replaced. Replacing it
-- cannot fail on existing rows: the new key is the old one plus a column, so it
-- is strictly less strict.
--
-- Rollback (cancel all but one live run of any source first, or it fails):
--   DROP INDEX IF EXISTS repurpose_runs_live_source_idx;
--   CREATE UNIQUE INDEX repurpose_runs_live_source_idx
--     ON repurpose_runs (workspace_id, source_fingerprint)
--     WHERE source_fingerprint IS NOT NULL
--       AND status NOT IN ('published', 'failed', 'cancelled');
--   and delete this file, or the next `db:migrate` puts the new one back.
DO $$
DECLARE
  current_definition text;
BEGIN
  SELECT indexdef INTO current_definition
    FROM pg_indexes
   WHERE schemaname = current_schema()
     AND indexname = 'repurpose_runs_live_source_idx';

  IF current_definition IS NULL
     OR position('COALESCE(window_start_ms' IN current_definition) = 0 THEN
    DROP INDEX IF EXISTS repurpose_runs_live_source_idx;
    CREATE UNIQUE INDEX repurpose_runs_live_source_idx
      ON repurpose_runs (workspace_id, source_fingerprint, (COALESCE(window_start_ms, -1)))
      WHERE source_fingerprint IS NOT NULL
        AND status NOT IN ('published', 'failed', 'cancelled');
  END IF;
END
$$;
