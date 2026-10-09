-- Ingestion & Input Engine Pillar 1 §08: Multi-Track Audio Demuxing & Speaker Channel Separation
-- Add media_audio_tracks table

CREATE TABLE IF NOT EXISTS "media_audio_tracks" (
  "id" TEXT NOT NULL,
  "media_asset_id" VARCHAR(26) NOT NULL,
  "stream_index" INTEGER NOT NULL,
  "channel_index" INTEGER NOT NULL DEFAULT 0,
  "label" TEXT,
  "audio_wav_uri" TEXT NOT NULL,
  "duration_ms" INTEGER NOT NULL,
  "is_dialogue" BOOLEAN NOT NULL DEFAULT true,
  "speaker_name" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "media_audio_tracks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_audio_tracks_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "media_audio_tracks_media_asset_id_idx" ON "media_audio_tracks"("media_asset_id");

