-- Voice-over hooks (2026-10-01, `apps/api/src/repurpose/voiceover`, OpusClip
-- parity wave 4): a short spoken line at the start of a clip, its hook read by
-- a stock synthetic voice (Sarvam's text-to-speech), laid on the clip's editing
-- documents as an accepted `sfx` cue - never baked into its media.
--
--   * clip_voiceovers: one request - one vendor call. Carries the words, the
--     language and the voice, the credits it holds (`cost_tenths`), what it
--     reserved of the day's rupee budget (`budget_day`, `budget_paise`), the
--     stored WAV (`audio_key`, `audio_duration_ms`) and which cue it put on
--     each shape's document (`placements`).
--
-- Purely additive: one enum, one table. Older code never reads it. The feature
-- is behind the flag `repurpose_voiceover`, which this migration does NOT
-- create: an operator does, with `_orchestration/tools/ops-flag.cjs`.
--
-- Rollback (after the api is rolled back; an older api never reads the table,
-- and an older render or browser export plays a voice-over cue already on a
-- document as an ordinary cue, cut with the video and without the duck):
--   DROP TABLE "clip_voiceovers";
--   DROP TYPE "VoiceoverStatus";

-- CreateEnum
CREATE TYPE "VoiceoverStatus" AS ENUM ('waiting', 'speaking', 'ready', 'failed', 'removed');

-- CreateTable
CREATE TABLE "clip_voiceovers" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "text" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "speaker" TEXT NOT NULL,
    "status" "VoiceoverStatus" NOT NULL DEFAULT 'waiting',
    "failure_code" TEXT,
    "failure_message" TEXT,
    "cost_tenths" INTEGER NOT NULL,
    "job_id" CHAR(26),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "audio_key" TEXT,
    "audio_duration_ms" INTEGER,
    "placements" JSONB NOT NULL DEFAULT '{}',
    "budget_day" TEXT,
    "budget_paise" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "clip_voiceovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clip_voiceovers_run_id_idx" ON "clip_voiceovers"("run_id");

-- CreateIndex
CREATE INDEX "clip_voiceovers_clip_id_idx" ON "clip_voiceovers"("clip_id");

-- CreateIndex
CREATE INDEX "clip_voiceovers_status_idx" ON "clip_voiceovers"("status");

-- AddForeignKey
ALTER TABLE "clip_voiceovers" ADD CONSTRAINT "clip_voiceovers_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_voiceovers" ADD CONSTRAINT "clip_voiceovers_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
