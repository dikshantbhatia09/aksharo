-- Learn what works (2026-10-05, `apps/api/src/repurpose/performance`): where a
-- clip went, how each post did, and - with enough of it - what a workspace's
-- best clips share.
--
--   * clip_posts: one post of one clip shape on one platform (and, for a dubbed
--     version, one language). Adopted from Postiz when a `publish_targets` row
--     goes out, or added from a link a person pasted ("I posted this").
--     `(workspace_id, post_key)` is unique: `post_key` is the platform's own id
--     for the post, parsed from its link, so a video is one post however many
--     times it is pasted. `next_read_at` schedules the measured reads of the
--     `repurpose.performance-refresh` task (off until MONTAJ_SCHEDULER_TASKS
--     names it); `latest` caches the newest value of each number.
--   * clip_post_snapshots: every set of numbers, as read (Postiz analytics, the
--     public YouTube watch page) or as typed by a person. Append-only.
--
-- Both hang off the run and the clip with ON DELETE CASCADE, so they go with
-- the run's source project (retention, the erasure cascade) like every other
-- clip table; a deleted publish target only clears `publish_target_id`.
--
-- Purely additive: two enums, two tables. Older code never reads them.
--
-- Rollback:
--   DROP TABLE "clip_post_snapshots";
--   DROP TABLE "clip_posts";
--   DROP TYPE "ClipMetricSource";
--   DROP TYPE "ClipPostSource";

-- CreateEnum
CREATE TYPE "ClipPostSource" AS ENUM ('postiz', 'link');

-- CreateEnum
CREATE TYPE "ClipMetricSource" AS ENUM ('postiz', 'youtube_page', 'person');

-- CreateTable
CREATE TABLE "clip_posts" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "aspect" "Aspect" NOT NULL,
    "language" TEXT,
    "platform" TEXT NOT NULL,
    "source" "ClipPostSource" NOT NULL,
    "publish_target_id" CHAR(26),
    "external_post_id" TEXT,
    "post_key" TEXT NOT NULL,
    "url" TEXT,
    "posted_at" TIMESTAMPTZ(6),
    "posted_time_known" BOOLEAN NOT NULL DEFAULT false,
    "latest" JSONB NOT NULL DEFAULT '{}',
    "next_read_at" TIMESTAMPTZ(6),
    "last_read_at" TIMESTAMPTZ(6),
    "reads" INTEGER NOT NULL DEFAULT 0,
    "read_failures" INTEGER NOT NULL DEFAULT 0,
    "last_read_error" TEXT,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_post_snapshots" (
    "id" CHAR(26) NOT NULL,
    "post_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "source" "ClipMetricSource" NOT NULL,
    "views" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "extra" JSONB,
    "read_at" TIMESTAMPTZ(6) NOT NULL,
    "entered_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_post_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clip_posts_publish_target_id_key" ON "clip_posts"("publish_target_id");

-- CreateIndex
CREATE INDEX "clip_posts_run_id_idx" ON "clip_posts"("run_id");

-- CreateIndex
CREATE INDEX "clip_posts_clip_id_idx" ON "clip_posts"("clip_id");

-- CreateIndex
CREATE INDEX "clip_posts_next_read_at_idx" ON "clip_posts"("next_read_at");

-- CreateIndex
CREATE UNIQUE INDEX "clip_posts_workspace_id_post_key_key" ON "clip_posts"("workspace_id", "post_key");

-- CreateIndex
CREATE INDEX "clip_post_snapshots_post_id_read_at_idx" ON "clip_post_snapshots"("post_id", "read_at");

-- AddForeignKey
ALTER TABLE "clip_posts" ADD CONSTRAINT "clip_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_posts" ADD CONSTRAINT "clip_posts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_posts" ADD CONSTRAINT "clip_posts_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_posts" ADD CONSTRAINT "clip_posts_publish_target_id_fkey" FOREIGN KEY ("publish_target_id") REFERENCES "publish_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_post_snapshots" ADD CONSTRAINT "clip_post_snapshots_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "clip_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

