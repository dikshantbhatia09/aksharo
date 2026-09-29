-- Set-and-forget clips (2026-10-02, `apps/api/src/repurpose/watches`): a
-- workspace connects a YouTube channel once, and every new upload it publishes
-- starts an Autopilot run with the saved setup.
--
--   * source_watches: one per (workspace, channel). The saved `setup` is the
--     start form's `setup`, validated with the same DTO; `next_check_at` is when
--     the `repurpose.source-watch` task may read the channel's feed again (an
--     hour or more after the last read); `cursor` holds the feed's video ids
--     already classified.
--   * source_watch_videos: one per (watch, video) the watch acted on - the
--     durable record that makes starting a video's run idempotent. A row is
--     written `pending`, claimed `starting`, then `started` with its run, so a
--     crash between the run and the cursor cannot start a second run.
--
-- Purely additive: three new enums, two new tables, nothing existing altered.
-- Older code never reads them, so rolling the API back needs no rollback here.
--
-- Rollback:
--   DROP TABLE "source_watch_videos";
--   DROP TABLE "source_watches";
--   DROP TYPE "SourceWatchVideoState";
--   DROP TYPE "SourceWatchState";
--   DROP TYPE "SourceWatchKind";

-- CreateEnum
CREATE TYPE "SourceWatchKind" AS ENUM ('youtube_channel');

-- CreateEnum
CREATE TYPE "SourceWatchState" AS ENUM ('active', 'paused', 'error');

-- CreateEnum
CREATE TYPE "SourceWatchVideoState" AS ENUM ('pending', 'starting', 'started', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "source_watches" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "kind" "SourceWatchKind" NOT NULL DEFAULT 'youtube_channel',
    "channel_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "setup" JSONB NOT NULL,
    "backfill_count" INTEGER NOT NULL DEFAULT 0,
    "state" "SourceWatchState" NOT NULL DEFAULT 'active',
    "state_reason" TEXT,
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_checked_at" TIMESTAMPTZ(6),
    "next_check_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "check_failures" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,
    "cursor" JSONB,
    "rights_attested_at" TIMESTAMPTZ(6) NOT NULL,
    "rights_attested_by" CHAR(26) NOT NULL,
    "created_by" CHAR(26) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_watches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_watch_videos" (
    "id" CHAR(26) NOT NULL,
    "watch_id" CHAR(26) NOT NULL,
    "video_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL,
    "state" "SourceWatchVideoState" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "backfill" BOOLEAN NOT NULL DEFAULT false,
    "run_id" CHAR(26),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_watch_videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "source_watches_state_next_check_at_idx" ON "source_watches"("state", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "source_watches_workspace_id_channel_id_key" ON "source_watches"("workspace_id", "channel_id");

-- CreateIndex
CREATE INDEX "source_watch_videos_watch_id_state_idx" ON "source_watch_videos"("watch_id", "state");

-- CreateIndex
CREATE INDEX "source_watch_videos_run_id_idx" ON "source_watch_videos"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_watch_videos_watch_id_video_id_key" ON "source_watch_videos"("watch_id", "video_id");

-- AddForeignKey
ALTER TABLE "source_watches" ADD CONSTRAINT "source_watches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_watch_videos" ADD CONSTRAINT "source_watch_videos_watch_id_fkey" FOREIGN KEY ("watch_id") REFERENCES "source_watches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_watch_videos" ADD CONSTRAINT "source_watch_videos_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
