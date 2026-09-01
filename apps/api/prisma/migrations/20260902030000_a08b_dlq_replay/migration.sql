-- A08b — dead-letter queue, admin replay, retry policy.
--
-- A08 shipped the dead-letter *decision* but had nowhere to put it: a final-attempt
-- failure wrote a `job.dead_lettered` job event with `data.dlq = true`, because
-- neither `jobs.dlq` nor a `dlq` table existed. This migration adds both and
-- backfills the table from those events, so no dead letter recorded by A08 is lost.
--
-- `attempt_no` is the ordinal of `jobs.attempt_id`: the ULID identifies an attempt,
-- this counts them, and the admin list needs to show "attempt 3 of 3".

-- CreateEnum
CREATE TYPE "DlqStatus" AS ENUM ('pending', 'replayed', 'discarded');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "attempt_no" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "dlq" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "dlq_at" TIMESTAMPTZ(6),
ADD COLUMN     "dlq_reason" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "is_admin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "dlq" (
    "id" CHAR(26) NOT NULL,
    "job_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26),
    "queue" TEXT NOT NULL,
    "job_key" TEXT NOT NULL,
    "attempt_id" CHAR(26) NOT NULL,
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "last_error" JSONB,
    "worst_case_tenths" INTEGER NOT NULL DEFAULT 0,
    "failed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "DlqStatus" NOT NULL DEFAULT 'pending',
    "resolved_by" CHAR(26),
    "resolved_at" TIMESTAMPTZ(6),
    "resolution" TEXT,

    CONSTRAINT "dlq_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dlq_queue_status_failed_at_idx" ON "dlq"("queue", "status", "failed_at");

-- CreateIndex
CREATE INDEX "dlq_workspace_id_status_idx" ON "dlq"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "dlq_status_failed_at_idx" ON "dlq"("status", "failed_at");

-- CreateIndex
CREATE UNIQUE INDEX "dlq_job_id_attempt_id_key" ON "dlq"("job_id", "attempt_id");

-- AddForeignKey
ALTER TABLE "dlq" ADD CONSTRAINT "dlq_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dlq" ADD CONSTRAINT "dlq_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Backfill from the A08 `job.dead_lettered` events.
--
-- The DLQ row takes the *event's* id: it is already a monotonic ULID minted at
-- the moment the dead letter was recorded, it is unique, and it makes the row and
-- the event that created it trivially traceable. `attempts` is the number of
-- `job.failed` events the job accumulated, floored at 1 — the true attempt count
-- was never written down, and one failure is the honest minimum.
--
-- Only jobs that are still `failed` are backfilled. A job an operator has since
-- retried by hand is not a pending dead letter.
-- ---------------------------------------------------------------------------
INSERT INTO "dlq" (
  "id", "job_id", "workspace_id", "project_id", "queue", "job_key",
  "attempt_id", "attempt_no", "attempts", "payload", "last_error",
  "worst_case_tenths", "failed_at", "status"
)
SELECT
  e."id",
  j."id",
  j."workspace_id",
  j."project_id",
  COALESCE(e."data" ->> 'queue', j."type"),
  j."job_key",
  COALESCE(e."data" ->> 'attemptId', j."attempt_id", j."id"),
  1,
  GREATEST(
    1,
    (SELECT COUNT(*)::int FROM "job_events" f
      WHERE f."job_id" = j."id" AND f."data" ->> 'event' = 'job.failed')
  ),
  j."params",
  e."data" -> 'lastError',
  0,
  e."at",
  'pending'
FROM "job_events" e
JOIN "jobs" j ON j."id" = e."job_id"
WHERE e."data" ->> 'event' = 'job.dead_lettered'
  AND e."data" ->> 'dlq' = 'true'
  AND j."status" = 'failed'
ON CONFLICT ("job_id", "attempt_id") DO NOTHING;

-- The marker on the job itself, from the rows just written.
UPDATE "jobs" j
SET "dlq" = true,
    "dlq_at" = d."failed_at",
    "dlq_reason" = COALESCE(d."last_error" ->> 'code', 'jobs/dead_lettered')
FROM "dlq" d
WHERE d."job_id" = j."id" AND d."status" = 'pending' AND j."dlq" = false;
