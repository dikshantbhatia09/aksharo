-- Livestream & VOD Ingestion Metadata (Pillar 1 §05)

CREATE TABLE IF NOT EXISTS "stream_vod_metadata" (
    "id" TEXT NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "platform" TEXT NOT NULL,
    "vod_id" TEXT NOT NULL,
    "total_duration_sec" DOUBLE PRECISION NOT NULL,
    "chat_velocity" JSONB,
    "selected_ranges" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stream_vod_metadata_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "stream_vod_metadata_project_id_key" ON "stream_vod_metadata"("project_id");

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stream_vod_metadata_project_id_fkey') THEN
        ALTER TABLE "stream_vod_metadata" ADD CONSTRAINT "stream_vod_metadata_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
