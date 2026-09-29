-- Dubbing (2026-10-04, `apps/api/src/repurpose/dubbing`): a clip dubbed into
-- other Indian languages in the speaker's own voice, with captions in the new
-- language.
--
--   * clip_dubs: one request - one vendor job (Sarvam's Dubbing API) for every
--     language asked for. Carries the person's consent to clone the voice
--     (`consent_by`, `consent_at`), the credits the request holds
--     (`cost_tenths`), what it reserved of the day's rupee budget
--     (`budget_day`, `budget_paise`), the vendor's job id, and the files each
--     language came back with (`tracks`).
--   * clip_dub_variants: one shape of the clip in one language, as its own
--     project (so the editor, captions, face track and export work on it
--     unchanged), with its captioned video like `clip_variants` has.
--   * jobs.checkpoint: what a worker said to resume from (the progress
--     callback's `checkpoint`). `ai.dub` writes the vendor's job id there
--     before it starts that job, so no attempt ever pays for a second one.
--
-- Purely additive: one enum, two tables, one nullable column. Older code never
-- reads them, and an older API strips `checkpoint` from a progress body (its
-- schema is not strict), so rolling the API back needs no rollback here.
--
-- Rollback:
--   DROP TABLE "clip_dub_variants";
--   DROP TABLE "clip_dubs";
--   DROP TYPE "DubStatus";
--   ALTER TABLE "jobs" DROP COLUMN "checkpoint";

-- CreateEnum
CREATE TYPE "DubStatus" AS ENUM ('waiting', 'dubbing', 'making', 'ready', 'failed', 'cancelled');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "checkpoint" JSONB;

-- CreateTable
CREATE TABLE "clip_dubs" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "source_language" TEXT NOT NULL,
    "languages" TEXT[],
    "status" "DubStatus" NOT NULL DEFAULT 'waiting',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "cost_tenths" INTEGER NOT NULL,
    "speakers" INTEGER NOT NULL DEFAULT -1,
    "vendor_job_id" TEXT,
    "job_id" CHAR(26),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "tracks" JSONB NOT NULL DEFAULT '[]',
    "budget_day" TEXT,
    "budget_paise" INTEGER NOT NULL DEFAULT 0,
    "consent_by" CHAR(26) NOT NULL,
    "consent_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "clip_dubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_dub_variants" (
    "id" CHAR(26) NOT NULL,
    "dub_id" CHAR(26) NOT NULL,
    "language" TEXT NOT NULL,
    "aspect" "Aspect" NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "caption_config" JSONB NOT NULL DEFAULT '{}',
    "edit_fingerprint" TEXT NOT NULL DEFAULT '',
    "status" "VariantStatus" NOT NULL DEFAULT 'preparing',
    "latest_export_id" CHAR(26),
    "mux_job_id" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_dub_variants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clip_dubs_run_id_idx" ON "clip_dubs"("run_id");

-- CreateIndex
CREATE INDEX "clip_dubs_clip_id_idx" ON "clip_dubs"("clip_id");

-- CreateIndex
CREATE INDEX "clip_dubs_status_idx" ON "clip_dubs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "clip_dub_variants_project_id_key" ON "clip_dub_variants"("project_id");

-- CreateIndex
CREATE INDEX "clip_dub_variants_dub_id_idx" ON "clip_dub_variants"("dub_id");

-- CreateIndex
CREATE UNIQUE INDEX "clip_dub_variants_dub_id_language_aspect_key" ON "clip_dub_variants"("dub_id", "language", "aspect");

-- AddForeignKey
ALTER TABLE "clip_dubs" ADD CONSTRAINT "clip_dubs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_dubs" ADD CONSTRAINT "clip_dubs_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_dub_variants" ADD CONSTRAINT "clip_dub_variants_dub_id_fkey" FOREIGN KEY ("dub_id") REFERENCES "clip_dubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_dub_variants" ADD CONSTRAINT "clip_dub_variants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_dub_variants" ADD CONSTRAINT "clip_dub_variants_latest_export_id_fkey" FOREIGN KEY ("latest_export_id") REFERENCES "exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

