-- Compilations and series (2026-10-03, `apps/api/src/repurpose/compilations.service.ts`
-- and `series.service.ts`).
--
--   * repurpose_compilations: a run's clips joined into one video in one shape
--     (their captioned videos, a short fade between them, an optional title
--     card first), made by `render.compilation`. One per (run, fingerprint of
--     the clip list, shape and title). The file is an ordinary `exports` row of
--     the run's source project (`export_id`, SET NULL when retention or a
--     delete removes the row), so export retention applies to it unchanged.
--   * repurpose_series: consecutive clips labelled "Part N of M"; `labels`
--     records what each shape's document had before, for "Remove series labels".
--
-- Purely additive: one enum, two tables, nothing existing altered. Older code
-- never reads them, so rolling the API back needs no rollback here.
--
-- Rollback:
--   DROP TABLE "repurpose_series";
--   DROP TABLE "repurpose_compilations";
--   DROP TYPE "CompilationStatus";

-- CreateEnum
CREATE TYPE "CompilationStatus" AS ENUM ('waiting', 'rendering', 'ready', 'failed');

-- CreateTable
CREATE TABLE "repurpose_compilations" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "aspect" "Aspect" NOT NULL,
    "title" TEXT,
    "clip_ids" JSONB NOT NULL,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "fingerprint" TEXT NOT NULL,
    "status" "CompilationStatus" NOT NULL DEFAULT 'waiting',
    "failure_code" TEXT,
    "duration_ms" INTEGER,
    "job_id" CHAR(26),
    "export_id" CHAR(26),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repurpose_compilations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repurpose_series" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "clip_ids" JSONB NOT NULL,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repurpose_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repurpose_compilations_export_id_key" ON "repurpose_compilations"("export_id");

-- CreateIndex
CREATE INDEX "repurpose_compilations_status_idx" ON "repurpose_compilations"("status");

-- CreateIndex
CREATE UNIQUE INDEX "repurpose_compilations_run_id_fingerprint_key" ON "repurpose_compilations"("run_id", "fingerprint");

-- CreateIndex
CREATE INDEX "repurpose_series_run_id_idx" ON "repurpose_series"("run_id");

-- AddForeignKey
ALTER TABLE "repurpose_compilations" ADD CONSTRAINT "repurpose_compilations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repurpose_compilations" ADD CONSTRAINT "repurpose_compilations_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repurpose_series" ADD CONSTRAINT "repurpose_series_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
