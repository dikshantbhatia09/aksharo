-- Pillar 1 §01: Direct YouTube URL Ingestion Engine
-- Schema tables for YouTube Source Metadata and Transcript Chapters

CREATE TABLE IF NOT EXISTS youtube_source_metadata (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id char(26) NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  video_id text NOT NULL,
  channel_title text NOT NULL,
  channel_url text,
  view_count bigint,
  published_at timestamptz(6),
  native_chapters jsonb NOT NULL DEFAULT '[]'::jsonb,
  ingest_mode text NOT NULL DEFAULT 'SPLIT_STREAM',
  egress_proxy_node text,
  created_at timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS youtube_source_metadata_video_id_idx ON youtube_source_metadata(video_id);

CREATE TABLE IF NOT EXISTS transcript_chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id char(26) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transcript_chapters_project_id_idx ON transcript_chapters(project_id);

