-- Pillar 1 §02: Cloud Storage Connectors (Google Drive, Dropbox, Box, OneDrive)
-- Schema tables for Workspace Cloud Integrations and Cloud Import Jobs

CREATE TABLE IF NOT EXISTS workspace_cloud_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id char(26) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_email text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  expires_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT workspace_cloud_integrations_workspace_provider_email_key UNIQUE (workspace_id, provider, account_email)
);

CREATE INDEX IF NOT EXISTS workspace_cloud_integrations_workspace_id_idx ON workspace_cloud_integrations(workspace_id);

CREATE TABLE IF NOT EXISTS cloud_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id char(26) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id char(26) REFERENCES projects(id) ON DELETE SET NULL,
  provider text NOT NULL,
  file_id text NOT NULL,
  file_name text NOT NULL,
  file_size_bytes bigint NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED',
  progress_pct integer NOT NULL DEFAULT 0,
  error_message text,
  s3_key text,
  source_url text,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  completed_at timestamptz(6)
);

CREATE INDEX IF NOT EXISTS cloud_import_jobs_workspace_id_idx ON cloud_import_jobs(workspace_id);
CREATE INDEX IF NOT EXISTS cloud_import_jobs_status_idx ON cloud_import_jobs(status);

