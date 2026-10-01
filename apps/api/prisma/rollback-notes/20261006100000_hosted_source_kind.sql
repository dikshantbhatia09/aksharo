-- Rollback for 20261006100000_hosted_source_kind (Vimeo, Google Drive and
-- Dropbox links, 2026-10-01). Run it BEFORE an api older than that migration
-- starts, and once more straight after the swap (a run created in between is
-- caught the second time). Safe to run any number of times.
--
-- Why: an older api's Prisma client does not know `hosted_url`, and throws on
-- any row that carries it - the run's own page, the runs list and Home all
-- fail for that workspace. So no row may carry it when that api is running.
--
-- What it does, in one transaction:
--
--   1. A hosted run whose video never arrived (no media of its source project
--      has `uploaded_at`) cannot be finished by an older api: its acquire
--      worker refuses the kind, and as an upload run it would sit waiting for
--      a file nobody is sending. It is CANCELLED, the way a Stop leaves a run
--      (`cancelled_at` set; the watchdog, Autopilot, clip reconcile and run
--      notices all skip a cancelled run). Runs already failed or cancelled
--      are left as they are.
--   2. Every hosted run becomes an `upload` run. Once its video has arrived,
--      nothing downstream reads the source kind for anything but "was this a
--      link"; the clips, captions and exports go on as before. "Process the
--      next part" stops being offered for it (an older api rebuilds only a
--      YouTube link from a fingerprint). The fingerprint and display are kept,
--      so a later re-deploy of the newer api can tell these runs apart:
--      `source_fingerprint ~ '^(vimeo|gdrive|dropbox):'`.
--
-- The enum value stays: Postgres cannot drop one, and an unused value is
-- harmless. Queued `media.acquire` jobs for these runs need no clean-up: an
-- older worker-media refuses `hosted_url` as `media/unsupported`, and the run
-- they belonged to is already cancelled.
--
-- Pipe it to psql on stdin (PowerShell strips the double quotes from a
-- `-c` argument, CLAUDE.md §20).

BEGIN;

UPDATE "repurpose_runs" AS r
SET "status" = 'cancelled',
    "cancelled_at" = date_trunc('milliseconds', now()),
    "updated_at" = date_trunc('milliseconds', now())
WHERE r."source_kind" = 'hosted_url'
  AND r."status" NOT IN ('failed', 'cancelled')
  AND NOT EXISTS (
    SELECT 1
    FROM "media_assets" AS m
    WHERE m."project_id" = r."source_project_id"
      AND m."uploaded_at" IS NOT NULL
  );

UPDATE "repurpose_runs"
SET "source_kind" = 'upload',
    "updated_at" = date_trunc('milliseconds', now())
WHERE "source_kind" = 'hosted_url';

-- Expect 0.
SELECT count(*) AS hosted_runs_left FROM "repurpose_runs" WHERE "source_kind" = 'hosted_url';

COMMIT;
