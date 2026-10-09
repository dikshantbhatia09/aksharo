-- Podcast RSS Ingestion & Automated Episode Watcher (Pillar 1 §06)

CREATE TABLE IF NOT EXISTS "podcast_shows" (
    "id" TEXT NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "title" TEXT NOT NULL,
    "feed_url" TEXT NOT NULL,
    "author" TEXT,
    "image_url" TEXT,
    "last_build_date" TIMESTAMPTZ(6),
    "etag" TEXT,
    "auto_repurpose" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "podcast_shows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "podcast_shows_feed_url_key" ON "podcast_shows"("feed_url");
CREATE INDEX IF NOT EXISTS "podcast_shows_workspace_id_idx" ON "podcast_shows"("workspace_id");

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'podcast_shows_workspace_id_fkey') THEN
        ALTER TABLE "podcast_shows" ADD CONSTRAINT "podcast_shows_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "podcast_episodes" (
    "id" TEXT NOT NULL,
    "show_id" TEXT NOT NULL,
    "guid" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "audio_url" TEXT NOT NULL,
    "duration_sec" DOUBLE PRECISION,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "is_processed" BOOLEAN NOT NULL DEFAULT false,
    "project_id" CHAR(26),
    "description" TEXT,
    "summary" TEXT,
    "chapters" JSONB DEFAULT '[]'::jsonb,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "podcast_episodes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "podcast_episodes_guid_key" ON "podcast_episodes"("guid");
CREATE INDEX IF NOT EXISTS "podcast_episodes_show_id_idx" ON "podcast_episodes"("show_id");
CREATE INDEX IF NOT EXISTS "podcast_episodes_is_processed_idx" ON "podcast_episodes"("is_processed");

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'podcast_episodes_show_id_fkey') THEN
        ALTER TABLE "podcast_episodes" ADD CONSTRAINT "podcast_episodes_show_id_fkey" FOREIGN KEY ("show_id") REFERENCES "podcast_shows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

