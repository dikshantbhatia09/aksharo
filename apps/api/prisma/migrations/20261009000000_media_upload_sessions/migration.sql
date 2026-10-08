-- Multipart resumable upload sessions (Pillar 1 §04)

CREATE TABLE IF NOT EXISTS "media_upload_sessions" (
    "id" TEXT NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "upload_id" TEXT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "chunk_size_bytes" INTEGER NOT NULL DEFAULT 16777216,
    "total_parts" INTEGER NOT NULL,
    "completed_parts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'UPLOADING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_upload_sessions_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_upload_sessions_workspace_id_fkey') THEN
        ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "media_upload_sessions_workspace_id_idx" ON "media_upload_sessions"("workspace_id");
CREATE INDEX IF NOT EXISTS "media_upload_sessions_upload_id_idx" ON "media_upload_sessions"("upload_id");

