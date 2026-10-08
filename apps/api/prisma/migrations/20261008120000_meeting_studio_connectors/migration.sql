-- Meeting & studio connectors (Pillar 1 §03) — Zoom OAuth & Webhook Event Ledger,
-- plus Cloud Integrations & Streaming Import Jobs (Pillar 1 §02).

CREATE TABLE IF NOT EXISTS "workspace_cloud_integrations" (
    "id" TEXT NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "provider" TEXT NOT NULL,
    "account_email" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_cloud_integrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_cloud_integrations_workspace_id_provider_account_email_key" UNIQUE ("workspace_id", "provider", "account_email")
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_cloud_integrations_workspace_id_fkey') THEN
        ALTER TABLE "workspace_cloud_integrations" ADD CONSTRAINT "workspace_cloud_integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "cloud_import_jobs" (
    "id" TEXT NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26),
    "provider" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_size_bytes" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "s3_key" TEXT,
    "source_url" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "cloud_import_jobs_pkey" PRIMARY KEY ("id")
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cloud_import_jobs_workspace_id_fkey') THEN
        ALTER TABLE "cloud_import_jobs" ADD CONSTRAINT "cloud_import_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "cloud_import_jobs_workspace_id_idx" ON "cloud_import_jobs"("workspace_id");
CREATE INDEX IF NOT EXISTS "cloud_import_jobs_status_idx" ON "cloud_import_jobs"("status");

-- Meeting & Studio Connectors (Zoom Cloud)
CREATE TABLE IF NOT EXISTS "workspace_zoom_integrations" (
    "id" TEXT NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "zoom_user_id" TEXT NOT NULL,
    "zoom_email" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "auto_repurpose" BOOLEAN NOT NULL DEFAULT true,
    "min_duration_sec" INTEGER NOT NULL DEFAULT 600,
    "name_filter" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workspace_zoom_integrations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "workspace_zoom_integrations_workspace_id_key" UNIQUE ("workspace_id")
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_zoom_integrations_workspace_id_fkey') THEN
        ALTER TABLE "workspace_zoom_integrations" ADD CONSTRAINT "workspace_zoom_integrations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "workspace_zoom_integrations_zoom_user_id_idx" ON "workspace_zoom_integrations"("zoom_user_id");

-- Zoom Webhook Event Ledger (Idempotent Webhook Log)
CREATE TABLE IF NOT EXISTS "zoom_recording_events" (
    "id" TEXT NOT NULL,
    "meeting_id" TEXT NOT NULL,
    "workspace_id" CHAR(26),
    "topic" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "file_count" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "project_id" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zoom_recording_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "zoom_recording_events_meeting_id_key" UNIQUE ("meeting_id")
);

CREATE INDEX IF NOT EXISTS "zoom_recording_events_status_idx" ON "zoom_recording_events"("status");
CREATE INDEX IF NOT EXISTS "zoom_recording_events_workspace_id_idx" ON "zoom_recording_events"("workspace_id");

