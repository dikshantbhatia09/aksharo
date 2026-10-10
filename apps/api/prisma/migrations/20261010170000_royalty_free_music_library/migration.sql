-- Pillar 5: Audio Engineering & Acoustic Clean-Up
-- 04: Royalty-Free Background Music Library Integration
-- Architecture & Implementation Plan: docs/features/05-audio-engineering-and-cleanup/04-royalty-free-music-library/ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md

-- CreateTable
CREATE TABLE IF NOT EXISTS "music_tracks" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL DEFAULT 'Aksharo Originals',
    "mood" TEXT NOT NULL,
    "tempo" TEXT NOT NULL,
    "bpm" INTEGER,
    "duration_sec" DOUBLE PRECISION NOT NULL,
    "preview_uri" TEXT NOT NULL,
    "master_uri" TEXT NOT NULL,
    "waveform_json" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "music_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "music_tracks_mood_idx" ON "music_tracks"("mood");
CREATE INDEX IF NOT EXISTS "music_tracks_tempo_idx" ON "music_tracks"("tempo");

-- AlterTable
ALTER TABLE "repurpose_clips" ADD COLUMN IF NOT EXISTS "music_track_id" TEXT;
ALTER TABLE "repurpose_clips" ADD COLUMN IF NOT EXISTS "music_volume" DOUBLE PRECISION DEFAULT 0.15;

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'repurpose_clips_music_track_id_fkey'
    ) THEN
        ALTER TABLE "repurpose_clips" ADD CONSTRAINT "repurpose_clips_music_track_id_fkey"
        FOREIGN KEY ("music_track_id") REFERENCES "music_tracks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

