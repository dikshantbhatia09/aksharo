-- REP-003 / REP-004: the repurposing core and the publishing ledger.
--
-- Purely additive: 13 new enum types, 9 new tables, their indexes and foreign
-- keys. It alters no existing table and drops nothing, so it is safe to apply
-- ahead of the feature and safe to leave in place if the feature is disabled.
--
-- Rollback: every object here is new and unreferenced by existing code, so a
-- rollback is `DROP TABLE` in reverse dependency order followed by `DROP TYPE`,
-- with no data migration and no effect on any existing row:
--
--   DROP TABLE IF EXISTS publish_targets, publish_batches, channel_connections,
--     review_items, review_bundles, clip_variants, repurpose_clips,
--     clip_candidates, repurpose_runs CASCADE;
--   DROP TYPE IF EXISTS "PublishTargetStatus", "PublishBatchStatus",
--     "PublishBatchMode", "PublishMode", "ChannelConnectionStatus",
--     "ReviewItemStatus", "ReviewBundleStatus", "VariantStatus",
--     "CandidateState", "CandidateSource", "RepurposeRunStatus",
--     "RepurposeMode", "RepurposeSourceKind";
--
-- The CHECK constraints and partial unique indexes these tables also need are in
-- `prisma/sql/0008-rep-repurpose-publish.sql`, applied by `pnpm db:migrate`
-- immediately after this migration (prisma/sql/README.md).

-- CreateEnum
CREATE TYPE "RepurposeSourceKind" AS ENUM ('upload', 'youtube_url', 'direct_media_url');

-- CreateEnum
CREATE TYPE "RepurposeMode" AS ENUM ('ai', 'manual', 'mixed');

-- CreateEnum
CREATE TYPE "RepurposeRunStatus" AS ENUM ('draft', 'acquiring', 'preparing_media', 'transcribing', 'analyzing', 'candidates_ready', 'materializing', 'rendering', 'review_ready', 'changes_requested', 'approved', 'publishing', 'partially_published', 'published', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "CandidateSource" AS ENUM ('ai', 'manual');

-- CreateEnum
CREATE TYPE "CandidateState" AS ENUM ('proposed', 'selected', 'rejected', 'materialized');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('preparing', 'rendering', 'ready', 'stale', 'failed');

-- CreateEnum
CREATE TYPE "ReviewBundleStatus" AS ENUM ('open', 'changes_requested', 'approved', 'expired');

-- CreateEnum
CREATE TYPE "ReviewItemStatus" AS ENUM ('needs_review', 'approved', 'changes_requested');

-- CreateEnum
CREATE TYPE "ChannelConnectionStatus" AS ENUM ('connected', 'attention', 'disconnected');

-- CreateEnum
CREATE TYPE "PublishMode" AS ENUM ('direct', 'schedule', 'mobile_handoff', 'download_only');

-- CreateEnum
CREATE TYPE "PublishBatchMode" AS ENUM ('now', 'mixed', 'scheduled');

-- CreateEnum
CREATE TYPE "PublishBatchStatus" AS ENUM ('pending', 'publishing', 'partially_published', 'published', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "PublishTargetStatus" AS ENUM ('draft', 'validating', 'ready', 'submitted', 'processing', 'published', 'scheduled', 'action_required', 'failed_retryable', 'failed_permanent', 'cancelled');

-- CreateTable
CREATE TABLE "repurpose_runs" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "source_project_id" CHAR(26) NOT NULL,
    "source_kind" "RepurposeSourceKind" NOT NULL,
    "source_url_encrypted" TEXT,
    "source_display" TEXT,
    "source_fingerprint" TEXT,
    "rights_attested_at" TIMESTAMPTZ(6),
    "rights_attested_by" CHAR(26),
    "mode" "RepurposeMode" NOT NULL,
    "status" "RepurposeRunStatus" NOT NULL DEFAULT 'draft',
    "config" JSONB NOT NULL DEFAULT '{}',
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "requested_candidates" INTEGER NOT NULL DEFAULT 5,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "current_stage" TEXT NOT NULL DEFAULT 'getting_video',
    "failure_code" TEXT,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "repurpose_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_candidates" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "source" "CandidateSource" NOT NULL,
    "state" "CandidateState" NOT NULL DEFAULT 'proposed',
    "rank" INTEGER,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "start_word_id" TEXT,
    "end_word_id" TEXT,
    "title" TEXT NOT NULL,
    "transcript_excerpt" TEXT NOT NULL DEFAULT '',
    "potential_score" INTEGER,
    "score_breakdown" JSONB,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "signals" JSONB,
    "signal_version" INTEGER NOT NULL DEFAULT 1,
    "prompt_version" TEXT,
    "model" TEXT,
    "feature_version" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repurpose_clips" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "candidate_id" CHAR(26) NOT NULL,
    "title" TEXT NOT NULL,
    "source_start_ms" INTEGER NOT NULL,
    "source_end_ms" INTEGER NOT NULL,
    "copy" JSONB NOT NULL DEFAULT '{}',
    "copy_version" INTEGER NOT NULL DEFAULT 1,
    "mezzanine_key" TEXT,
    "mezzanine_checksum" TEXT,
    "mezzanine_duration_ms" INTEGER,
    "mezzanine_job_id" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repurpose_clips_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clip_variants" (
    "id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "aspect" "Aspect" NOT NULL,
    "profile_version" TEXT NOT NULL DEFAULT '1',
    "caption_config" JSONB NOT NULL DEFAULT '{}',
    "edit_fingerprint" TEXT NOT NULL DEFAULT '',
    "status" "VariantStatus" NOT NULL DEFAULT 'preparing',
    "latest_export_id" CHAR(26),
    "approved_at" TIMESTAMPTZ(6),
    "approved_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_bundles" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "status" "ReviewBundleStatus" NOT NULL DEFAULT 'open',
    "share_link_id" CHAR(26),
    "expires_at" TIMESTAMPTZ(6),
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "review_items" (
    "id" CHAR(26) NOT NULL,
    "bundle_id" CHAR(26) NOT NULL,
    "variant_id" CHAR(26) NOT NULL,
    "status" "ReviewItemStatus" NOT NULL DEFAULT 'needs_review',
    "decision_by" CHAR(26),
    "decision_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "fingerprint_at_decision" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "provider" TEXT NOT NULL,
    "external_integration_id" TEXT NOT NULL,
    "external_organization_id" TEXT,
    "display_name" TEXT,
    "username" TEXT,
    "avatar_url" TEXT,
    "connection_status" "ChannelConnectionStatus" NOT NULL DEFAULT 'connected',
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "capabilities_version" INTEGER NOT NULL DEFAULT 1,
    "last_verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_batches" (
    "id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "confirmed_by" CHAR(26),
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" "PublishBatchMode" NOT NULL DEFAULT 'now',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "PublishBatchStatus" NOT NULL DEFAULT 'pending',
    "target_count" INTEGER NOT NULL DEFAULT 0,
    "published_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_targets" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "batch_id" CHAR(26) NOT NULL,
    "clip_id" CHAR(26) NOT NULL,
    "variant_id" CHAR(26) NOT NULL,
    "channel_connection_id" CHAR(26),
    "provider" TEXT NOT NULL,
    "publish_mode" "PublishMode" NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6),
    "copy" JSONB NOT NULL DEFAULT '{}',
    "copy_version" INTEGER NOT NULL DEFAULT 1,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "settings_version" INTEGER NOT NULL DEFAULT 1,
    "artifact_fingerprint" TEXT NOT NULL DEFAULT '',
    "export_id" CHAR(26),
    "status" "PublishTargetStatus" NOT NULL DEFAULT 'draft',
    "attempt_no" INTEGER NOT NULL DEFAULT 0,
    "idempotency_key" TEXT NOT NULL,
    "external_post_id" TEXT,
    "external_url" TEXT,
    "external_status" TEXT,
    "last_error_code" TEXT,
    "last_error_safe_message" TEXT,
    "retry_after" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "repurpose_runs_workspace_id_idx" ON "repurpose_runs"("workspace_id");

-- CreateIndex
CREATE INDEX "repurpose_runs_workspace_id_created_at_idx" ON "repurpose_runs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "repurpose_runs_workspace_id_status_updated_at_idx" ON "repurpose_runs"("workspace_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "repurpose_runs_source_project_id_idx" ON "repurpose_runs"("source_project_id");

-- CreateIndex
CREATE INDEX "repurpose_runs_workspace_id_source_fingerprint_idx" ON "repurpose_runs"("workspace_id", "source_fingerprint");

-- CreateIndex
CREATE INDEX "clip_candidates_run_id_idx" ON "clip_candidates"("run_id");

-- CreateIndex
CREATE INDEX "clip_candidates_run_id_state_idx" ON "clip_candidates"("run_id", "state");

-- CreateIndex
CREATE INDEX "clip_candidates_run_id_rank_idx" ON "clip_candidates"("run_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "clip_candidates_run_id_start_ms_end_ms_key" ON "clip_candidates"("run_id", "start_ms", "end_ms");

-- CreateIndex
CREATE UNIQUE INDEX "repurpose_clips_candidate_id_key" ON "repurpose_clips"("candidate_id");

-- CreateIndex
CREATE INDEX "repurpose_clips_run_id_idx" ON "repurpose_clips"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "clip_variants_project_id_key" ON "clip_variants"("project_id");

-- CreateIndex
CREATE INDEX "clip_variants_clip_id_idx" ON "clip_variants"("clip_id");

-- CreateIndex
CREATE INDEX "clip_variants_status_idx" ON "clip_variants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "clip_variants_clip_id_aspect_key" ON "clip_variants"("clip_id", "aspect");

-- CreateIndex
CREATE INDEX "review_bundles_run_id_idx" ON "review_bundles"("run_id");

-- CreateIndex
CREATE INDEX "review_bundles_workspace_id_idx" ON "review_bundles"("workspace_id");

-- CreateIndex
CREATE INDEX "review_items_variant_id_idx" ON "review_items"("variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "review_items_bundle_id_variant_id_key" ON "review_items"("bundle_id", "variant_id");

-- CreateIndex
CREATE INDEX "channel_connections_workspace_id_idx" ON "channel_connections"("workspace_id");

-- CreateIndex
CREATE INDEX "channel_connections_workspace_id_provider_idx" ON "channel_connections"("workspace_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_workspace_id_external_integration_id_key" ON "channel_connections"("workspace_id", "external_integration_id");

-- CreateIndex
CREATE INDEX "publish_batches_run_id_idx" ON "publish_batches"("run_id");

-- CreateIndex
CREATE INDEX "publish_batches_workspace_id_idx" ON "publish_batches"("workspace_id");

-- CreateIndex
CREATE INDEX "publish_batches_workspace_id_status_idx" ON "publish_batches"("workspace_id", "status");

-- CreateIndex
CREATE INDEX "publish_targets_batch_id_idx" ON "publish_targets"("batch_id");

-- CreateIndex
CREATE INDEX "publish_targets_workspace_id_idx" ON "publish_targets"("workspace_id");

-- CreateIndex
CREATE INDEX "publish_targets_variant_id_idx" ON "publish_targets"("variant_id");

-- CreateIndex
CREATE INDEX "publish_targets_channel_connection_id_idx" ON "publish_targets"("channel_connection_id");

-- CreateIndex
CREATE INDEX "publish_targets_status_retry_after_idx" ON "publish_targets"("status", "retry_after");

-- CreateIndex
CREATE INDEX "publish_targets_provider_external_post_id_idx" ON "publish_targets"("provider", "external_post_id");

-- AddForeignKey
ALTER TABLE "repurpose_runs" ADD CONSTRAINT "repurpose_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repurpose_runs" ADD CONSTRAINT "repurpose_runs_source_project_id_fkey" FOREIGN KEY ("source_project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_candidates" ADD CONSTRAINT "clip_candidates_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repurpose_clips" ADD CONSTRAINT "repurpose_clips_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repurpose_clips" ADD CONSTRAINT "repurpose_clips_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "clip_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repurpose_clips" ADD CONSTRAINT "repurpose_clips_mezzanine_job_id_fkey" FOREIGN KEY ("mezzanine_job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_variants" ADD CONSTRAINT "clip_variants_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_variants" ADD CONSTRAINT "clip_variants_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clip_variants" ADD CONSTRAINT "clip_variants_latest_export_id_fkey" FOREIGN KEY ("latest_export_id") REFERENCES "exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bundles" ADD CONSTRAINT "review_bundles_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bundles" ADD CONSTRAINT "review_bundles_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_bundles" ADD CONSTRAINT "review_bundles_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "review_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "clip_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batches" ADD CONSTRAINT "publish_batches_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_batches" ADD CONSTRAINT "publish_batches_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "publish_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "repurpose_clips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "clip_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_channel_connection_id_fkey" FOREIGN KEY ("channel_connection_id") REFERENCES "channel_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_targets" ADD CONSTRAINT "publish_targets_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

