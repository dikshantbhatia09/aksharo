-- Clip review (2026-10-03, `apps/api/src/repurpose/review`): a team approves a
-- run's clips before they go out and comments on them, and a client reviews
-- them from a link without an account.
--
--   * `clip_reviews`       - one row per reviewed clip: its state, who decided,
--                            and the captioned videos the decision was made on
--                            (a clip without a row is pending);
--   * `clip_review_events` - every decision, append-only;
--   * `clip_comments`      - comments by members, and by clients through a link;
--   * `clip_review_links`  - the client links, stored as a SHA-256 of the token
--                            (the token itself is never stored).
--
-- The workspace setting "Clips need approval before posting" is a key in the
-- existing `workspaces.settings` JSON (`clipsNeedApproval`), so no column here.
--
-- Purely additive: two enums and four new tables; nothing existing is altered,
-- and older code never reads any of them.
--
-- Rollback:
--   DROP TABLE "clip_comments";
--   DROP TABLE "clip_review_events";
--   DROP TABLE "clip_reviews";
--   DROP TABLE "clip_review_links";
--   DROP TYPE "ReviewActorKind";
--   DROP TYPE "ClipReviewState";

-- CreateEnum
CREATE TYPE "ClipReviewState" AS ENUM ('pending', 'approved', 'changes_requested');

-- CreateEnum
CREATE TYPE "ReviewActorKind" AS ENUM ('member', 'client', 'system');

-- CreateTable
CREATE TABLE "clip_reviews" (
    "clip_id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "state" "ClipReviewState" NOT NULL DEFAULT 'pending',
    "actor_kind" "ReviewActorKind" NOT NULL,
    "actor_user_id" CHAR(26),
    "actor_name" TEXT,
    "review_link_id" CHAR(26),
    "videos" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_reviews_pkey" PRIMARY KEY ("clip_id")
);

-- CreateTable
CREATE TABLE "clip_review_events" (
    "id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "state" "ClipReviewState" NOT NULL,
    "actor_kind" "ReviewActorKind" NOT NULL,
    "actor_user_id" CHAR(26),
    "actor_name" TEXT,
    "review_link_id" CHAR(26),
    "note" TEXT,
    "reason" TEXT,
    "videos" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_review_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_comments" (
    "id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "author_kind" "ReviewActorKind" NOT NULL,
    "author_user_id" CHAR(26),
    "author_name" TEXT,
    "review_link_id" CHAR(26),
    "body" TEXT NOT NULL,
    "at_ms" INTEGER,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_review_links" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "label" TEXT,
    "require_name" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" CHAR(26),
    "created_by" CHAR(26),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "last_viewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_review_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clip_reviews_run_id_idx" ON "clip_reviews"("run_id");

-- CreateIndex
CREATE INDEX "clip_reviews_workspace_id_state_idx" ON "clip_reviews"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "clip_review_events_clip_id_created_at_idx" ON "clip_review_events"("clip_id", "created_at");

-- CreateIndex
CREATE INDEX "clip_review_events_run_id_idx" ON "clip_review_events"("run_id");

-- CreateIndex
CREATE INDEX "clip_comments_clip_id_created_at_idx" ON "clip_comments"("clip_id", "created_at");

-- CreateIndex
CREATE INDEX "clip_comments_run_id_idx" ON "clip_comments"("run_id");

-- CreateIndex
CREATE INDEX "clip_comments_review_link_id_idx" ON "clip_comments"("review_link_id");

-- CreateIndex
CREATE UNIQUE INDEX "clip_review_links_token_hash_key" ON "clip_review_links"("token_hash");

-- CreateIndex
CREATE INDEX "clip_review_links_run_id_idx" ON "clip_review_links"("run_id");

-- CreateIndex
CREATE INDEX "clip_review_links_workspace_id_idx" ON "clip_review_links"("workspace_id");

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_reviews" ADD CONSTRAINT "clip_reviews_review_link_id_fkey" FOREIGN KEY ("review_link_id") REFERENCES "clip_review_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_events" ADD CONSTRAINT "clip_review_events_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_events" ADD CONSTRAINT "clip_review_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_events" ADD CONSTRAINT "clip_review_events_review_link_id_fkey" FOREIGN KEY ("review_link_id") REFERENCES "clip_review_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_comments" ADD CONSTRAINT "clip_comments_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_comments" ADD CONSTRAINT "clip_comments_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_comments" ADD CONSTRAINT "clip_comments_review_link_id_fkey" FOREIGN KEY ("review_link_id") REFERENCES "clip_review_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_review_links" ADD CONSTRAINT "clip_review_links_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

