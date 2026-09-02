-- CreateEnum
CREATE TYPE "audio_clean_strength" AS ENUM ('light', 'medium', 'strong');

-- CreateEnum
CREATE TYPE "audio_clean_target" AS ENUM ('social', 'youtube', 'podcast');

-- CreateEnum
CREATE TYPE "audio_clean_status" AS ENUM ('queued', 'running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "audio_cleans" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "media_id" CHAR(26) NOT NULL,
    "strength" "audio_clean_strength" NOT NULL DEFAULT 'medium',
    "target" "audio_clean_target" NOT NULL DEFAULT 'social',
    "dereverb" BOOLEAN NOT NULL DEFAULT false,
    "deesser" BOOLEAN NOT NULL DEFAULT false,
    "status" "audio_clean_status" NOT NULL DEFAULT 'queued',
    "job_id" CHAR(26),
    "metrics" JSONB,
    "storage_keys" JSONB NOT NULL DEFAULT '{}',
    "failure_reason" TEXT,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "audio_cleans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audio_cleans_project_id_idx" ON "audio_cleans"("project_id");

-- CreateIndex
CREATE INDEX "audio_cleans_media_id_idx" ON "audio_cleans"("media_id");

-- CreateIndex
CREATE INDEX "audio_cleans_project_id_created_at_idx" ON "audio_cleans"("project_id", "created_at");

-- AddForeignKey
ALTER TABLE "audio_cleans" ADD CONSTRAINT "audio_cleans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_cleans" ADD CONSTRAINT "audio_cleans_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audio_cleans" ADD CONSTRAINT "audio_cleans_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
