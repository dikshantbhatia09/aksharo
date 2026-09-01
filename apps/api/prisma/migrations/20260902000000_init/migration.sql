-- A03 — initial schema for 03-architecture/06-data-model.md (v2).
--
-- The `vector` extension is created FIRST: `audio_assets.embedding` is
-- `vector(512)`, so the type must exist before the table that uses it. Prisma
-- applies this file verbatim, so the extension travels with the schema change
-- and `prisma migrate deploy` reproduces it exactly in staging and production.
-- The same statement is repeated in `prisma/sql/0001-extensions.sql` so the hand
-- SQL step can repair a database that lost it.

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Jurisdiction" AS ENUM ('IN', 'EU', 'OTHER');

-- CreateEnum
CREATE TYPE "AgeBracket" AS ENUM ('adult', 'minor');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('analytics', 'memory', 'marketing', 'share_upload', 'affiliate');

-- CreateEnum
CREATE TYPE "DsrKind" AS ENUM ('access', 'erasure', 'export', 'correction');

-- CreateEnum
CREATE TYPE "DsrStatus" AS ENUM ('received', 'verifying', 'in_progress', 'completed', 'rejected');

-- CreateEnum
CREATE TYPE "BreachStatus" AS ENUM ('detected', 'investigating', 'contained', 'notified', 'closed');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('google', 'email', 'magic');

-- CreateEnum
CREATE TYPE "ClientKind" AS ENUM ('web', 'desktop', 'bridge', 'premiere', 'ae', 'resolve', 'api');

-- CreateEnum
CREATE TYPE "WorkspaceType" AS ENUM ('personal', 'team', 'agency');

-- CreateEnum
CREATE TYPE "Region" AS ENUM ('in', 'eu', 'us');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('INR', 'USD');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('invited', 'active', 'suspended', 'removed');

-- CreateEnum
CREATE TYPE "HostApp" AS ENUM ('web', 'desktop', 'premiere', 'ae', 'resolve');

-- CreateEnum
CREATE TYPE "ApiKeyScope" AS ENUM ('read', 'jobs', 'webhooks');

-- CreateEnum
CREATE TYPE "DeviceCodeStatus" AS ENUM ('pending', 'approved', 'denied', 'expired', 'consumed');

-- CreateEnum
CREATE TYPE "MediaRole" AS ENUM ('primary', 'broll', 'audio', 'font', 'image');

-- CreateEnum
CREATE TYPE "StorageBucket" AS ENUM ('s3', 'r2');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('pending', 'uploading', 'uploaded', 'probing', 'ready', 'failed', 'purged');

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('draft', 'active', 'archived');

-- CreateEnum
CREATE TYPE "Aspect" AS ENUM ('9:16', '16:9', '1:1', '4:5');

-- CreateEnum
CREATE TYPE "PassType" AS ENUM ('autocut', 'reframe', 'sfx', 'music', 'textfx', 'prompted');

-- CreateEnum
CREATE TYPE "ItemKind" AS ENUM ('cut', 'zoom', 'reframe', 'sfx', 'music', 'title');

-- CreateEnum
CREATE TYPE "ItemState" AS ENUM ('proposed', 'accepted', 'rejected', 'modified');

-- CreateEnum
CREATE TYPE "PassStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'merged', 'cancelled');

-- CreateEnum
CREATE TYPE "EdgSource" AS ENUM ('web', 'desktop', 'premiere', 'ae', 'resolve', 'worker');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('debug', 'info', 'warn', 'error');

-- CreateEnum
CREATE TYPE "RetentionClass" AS ENUM ('zero_retention', 'short_retention', 'vendor_default');

-- CreateEnum
CREATE TYPE "ExportKind" AS ENUM ('mp4', 'mov', 'srt', 'vtt', 'ass', 'txt', 'docx', 'md');

-- CreateEnum
CREATE TYPE "RenderMode" AS ENUM ('browser', 'cloud');

-- CreateEnum
CREATE TYPE "PlanKey" AS ENUM ('free', 'starter', 'creator', 'studio', 'agency');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('razorpay', 'none');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "BillingInterval" AS ENUM ('month', 'year', 'halfyear', 'once');

-- CreateEnum
CREATE TYPE "MandateMethod" AS ENUM ('upi_autopay', 'card', 'enach');

-- CreateEnum
CREATE TYPE "MandateStatus" AS ENUM ('pending', 'active', 'paused', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "PassPurchaseKind" AS ENUM ('first_export', 'week_pass', 'pay_once', 'topup');

-- CreateEnum
CREATE TYPE "InvoiceDocType" AS ENUM ('tax_invoice', 'export_invoice', 'bill_of_supply', 'credit_note', 'debit_note', 'self_invoice');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('intra_state', 'inter_state', 'export', 'sez', 'import_rcm');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'issued', 'paid', 'cancelled', 'void');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('upi', 'upi_autopay', 'card', 'netbanking', 'wallet', 'emandate');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('created', 'authorized', 'captured', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "EdpmsStatus" AS ENUM ('pending', 'reported', 'closed');

-- CreateEnum
CREATE TYPE "CreditLotSource" AS ENUM ('grant', 'topup', 'pass', 'referral', 'adjust', 'reversal');

-- CreateEnum
CREATE TYPE "CreditHoldStatus" AS ENUM ('held', 'settled', 'released', 'partially_settled');

-- CreateEnum
CREATE TYPE "CreditLedgerKind" AS ENUM ('grant', 'purchase', 'hold', 'settle', 'release', 'reversal', 'refund', 'adjust', 'expire', 'referral_bonus');

-- CreateEnum
CREATE TYPE "AffiliateStatus" AS ENUM ('pending', 'approved', 'suspended', 'rejected');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('pending', 'attributed', 'converted', 'rejected');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('pending', 'payable', 'paid', 'clawed_back');

-- CreateEnum
CREATE TYPE "TdsSection" AS ENUM ('194H', '194O');

-- CreateEnum
CREATE TYPE "PayoutRail" AS ENUM ('neft', 'imps', 'rtgs', 'upi');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('pending', 'processing', 'paid', 'failed', 'reversed');

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM ('pending', 'granted', 'revoked');

-- CreateEnum
CREATE TYPE "ShareReportCategory" AS ENUM ('ncii', 'impersonation', 'copyright', 'other');

-- CreateEnum
CREATE TYPE "AudioAssetKind" AS ENUM ('sfx', 'music');

-- CreateEnum
CREATE TYPE "AudioProvider" AS ENUM ('owned', 'epidemic', 'soundstripe', 'storyblocks', 'beatoven', 'hoopr');

-- CreateEnum
CREATE TYPE "CatalogueMode" AS ENUM ('mirrored', 'live_fetch');

-- CreateEnum
CREATE TYPE "ClearanceMethod" AS ENUM ('none', 'channel_safelist', 'per_video_code', 'platform_covered');

-- CreateEnum
CREATE TYPE "AssetSurface" AS ENUM ('cloud_render', 'panel', 'desktop', 'api');

-- CreateEnum
CREATE TYPE "AssetScope" AS ENUM ('channel', 'video');

-- CreateEnum
CREATE TYPE "ClearanceGrantStatus" AS ENUM ('pending', 'active', 'revoked', 'expired');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'delivered', 'failed', 'dead');

-- CreateTable
CREATE TABLE "users" (
    "id" CHAR(26) NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "name" TEXT,
    "avatar_url" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-IN',
    "password_hash" TEXT,
    "mfa_secret" TEXT,
    "date_of_birth" DATE,
    "jurisdiction" "Jurisdiction" NOT NULL DEFAULT 'OTHER',
    "age_bracket" "AgeBracket" NOT NULL DEFAULT 'adult',
    "parental_consent_ref" TEXT,
    "age_assured_at" TIMESTAMPTZ(6),
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "analytics_consent_at" TIMESTAMPTZ(6),
    "memory_consent_at" TIMESTAMPTZ(6),
    "onboarding" JSONB NOT NULL DEFAULT '{}',
    "last_seen_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26),
    "purpose" "ConsentPurpose" NOT NULL,
    "version" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT true,
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawn_at" TIMESTAMPTZ(6),
    "ip" TEXT,
    "ua" TEXT,
    "notice_version" TEXT NOT NULL,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsr_requests" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "kind" "DsrKind" NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "DsrStatus" NOT NULL DEFAULT 'received',
    "completed_at" TIMESTAMPTZ(6),
    "evidence_key" TEXT,

    CONSTRAINT "dsr_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_incidents" (
    "id" CHAR(26) NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "affected_count" INTEGER NOT NULL DEFAULT 0,
    "board_notified_at" TIMESTAMPTZ(6),
    "users_notified_at" TIMESTAMPTZ(6),
    "status" "BreachStatus" NOT NULL DEFAULT 'detected',
    "postmortem_key" TEXT,

    CONSTRAINT "breach_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_logs" (
    "id" CHAR(26) NOT NULL,
    "actor_id" CHAR(26),
    "workspace_id" CHAR(26),
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ip" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identities" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "provider_id" TEXT NOT NULL,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "kind" "ClientKind" NOT NULL,
    "family_id" CHAR(26) NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "previous_hash" TEXT,
    "rotated_at" TIMESTAMPTZ(6),
    "device_id" CHAR(26),
    "ip" TEXT,
    "ua" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" CHAR(26) NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "WorkspaceType" NOT NULL DEFAULT 'personal',
    "owner_id" CHAR(26) NOT NULL,
    "region" "Region" NOT NULL DEFAULT 'in',
    "currency" "Currency" NOT NULL DEFAULT 'INR',
    "billing_country" CHAR(2) NOT NULL,
    "billing_state_code" VARCHAR(2),
    "gstin" TEXT,
    "gstin_verified_at" TIMESTAMPTZ(6),
    "legal_name" TEXT,
    "billing_address" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "retention_days" INTEGER NOT NULL DEFAULT 7,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26),
    "role" "MembershipRole" NOT NULL DEFAULT 'viewer',
    "seat_billed" BOOLEAN NOT NULL DEFAULT false,
    "invited_email" TEXT,
    "status" "MembershipStatus" NOT NULL DEFAULT 'invited',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "host" "HostApp" NOT NULL,
    "host_version" TEXT,
    "app_version" TEXT,
    "fingerprint" TEXT NOT NULL,
    "last_active_at" TIMESTAMPTZ(6),
    "lease_until" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_keys" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT,
    "max_activations" INTEGER NOT NULL DEFAULT 1,
    "activations" JSONB NOT NULL DEFAULT '[]',
    "offline_until" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revocation_serial" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scopes" "ApiKeyScope"[],
    "rate_limit" INTEGER NOT NULL DEFAULT 60,
    "last_used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_codes" (
    "id" CHAR(26) NOT NULL,
    "device_code" TEXT NOT NULL,
    "user_code" TEXT NOT NULL,
    "client_kind" "ClientKind" NOT NULL,
    "host_app" "HostApp",
    "device_info" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "status" "DeviceCodeStatus" NOT NULL DEFAULT 'pending',
    "approved_by" CHAR(26),
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "poll_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bridge_pairings" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "device_id" CHAR(26),
    "host_app" "HostApp" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "scope" JSONB NOT NULL DEFAULT '{}',
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "bridge_pairings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "title" TEXT NOT NULL,
    "folder_id" CHAR(26),
    "client_tag" TEXT,
    "source_language" TEXT,
    "scripts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "aspect" "Aspect" NOT NULL DEFAULT '9:16',
    "status" "ProjectStatus" NOT NULL DEFAULT 'draft',
    "thumbnail_key" TEXT,
    "duration_ms" INTEGER,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_until" TIMESTAMPTZ(6),
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "role" "MediaRole" NOT NULL DEFAULT 'primary',
    "bucket" "StorageBucket" NOT NULL DEFAULT 's3',
    "storage_key" TEXT NOT NULL,
    "size_bytes" BIGINT,
    "content_hash" TEXT,
    "mime" TEXT,
    "duration_ms" INTEGER,
    "fps" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "audio_channels" INTEGER,
    "proxy_key" TEXT,
    "audio16k_key" TEXT,
    "audio48k_key" TEXT,
    "waveform_key" TEXT,
    "status" "MediaStatus" NOT NULL DEFAULT 'pending',
    "uploaded_at" TIMESTAMPTZ(6),
    "raw_purge_at" TIMESTAMPTZ(6),
    "derived_purge_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcripts" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "language" TEXT NOT NULL,
    "detected_languages" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT,
    "model" TEXT,
    "aligner_model" TEXT,
    "diariser" TEXT,
    "current_revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_chunks" (
    "id" CHAR(26) NOT NULL,
    "transcript_id" CHAR(26) NOT NULL,
    "revision" INTEGER NOT NULL,
    "chunk_idx" INTEGER NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "words" JSONB NOT NULL DEFAULT '[]',
    "next_word_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edg_documents" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "schema_version" INTEGER NOT NULL DEFAULT 2,
    "doc" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edg_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edg_segments" (
    "id" CHAR(26) NOT NULL,
    "edg_id" CHAR(26) NOT NULL,
    "seq" DECIMAL(65,30) NOT NULL,
    "start_word_id" TEXT NOT NULL,
    "end_word_id" TEXT NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "style_ref" TEXT,
    "text_overrides" JSONB NOT NULL DEFAULT '{}',
    "emphasis" JSONB NOT NULL DEFAULT '[]',
    "position" JSONB,
    "overrides" JSONB,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "updated_at_rev" INTEGER NOT NULL DEFAULT 0,
    "deleted_at_rev" INTEGER,

    CONSTRAINT "edg_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edg_passes" (
    "id" CHAR(26) NOT NULL,
    "edg_id" CHAR(26) NOT NULL,
    "type" "PassType" NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'flash',
    "params" JSONB NOT NULL DEFAULT '{}',
    "status" "PassStatus" NOT NULL DEFAULT 'queued',
    "job_id" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edg_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edg_pass_items" (
    "id" CHAR(26) NOT NULL,
    "pass_id" CHAR(26) NOT NULL,
    "edg_id" CHAR(26) NOT NULL,
    "kind" "ItemKind" NOT NULL,
    "start_ms" INTEGER NOT NULL,
    "end_ms" INTEGER NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "keyframes" BYTEA,
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "state" "ItemState" NOT NULL DEFAULT 'proposed',
    "licence_snapshot" JSONB,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" CHAR(26),

    CONSTRAINT "edg_pass_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edg_revisions" (
    "id" CHAR(26) NOT NULL,
    "edg_id" CHAR(26) NOT NULL,
    "revision" INTEGER NOT NULL,
    "ops" JSONB NOT NULL DEFAULT '[]',
    "client_op_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "author" CHAR(26),
    "source" "EdgSource" NOT NULL DEFAULT 'web',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edg_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edg_snapshots" (
    "id" CHAR(26) NOT NULL,
    "edg_id" CHAR(26) NOT NULL,
    "revision" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 2,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edg_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "style_presets" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26),
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "doc" JSONB NOT NULL DEFAULT '{}',
    "preview_key" TEXT,
    "ass_renderable" BOOLEAN NOT NULL DEFAULT false,
    "ass_exportable" BOOLEAN NOT NULL DEFAULT false,
    "requires_layout_metrics" BOOLEAN NOT NULL DEFAULT true,
    "parity_score" DOUBLE PRECISION,
    "min_plan" "PlanKey" NOT NULL DEFAULT 'free',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "style_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brand_kits" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "name" TEXT NOT NULL,
    "doc" JSONB NOT NULL DEFAULT '{}',
    "logo_key" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fonts" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "family" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'regular',
    "storage_key" TEXT NOT NULL,
    "subset_key" TEXT,
    "size_bytes" BIGINT,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "licence_attested_by" CHAR(26),
    "attested_at" TIMESTAMPTZ(6),
    "licence_note" TEXT,
    "served_only_to_workspace" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fonts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_entries" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26),
    "consent_id" CHAR(26) NOT NULL,
    "kind" TEXT NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_links" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "token" TEXT NOT NULL,
    "indexable" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "accepted_aup_version" TEXT,
    "report_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "share_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_reports" (
    "id" CHAR(26) NOT NULL,
    "share_link_id" CHAR(26) NOT NULL,
    "reporter_contact" TEXT,
    "category" "ShareReportCategory" NOT NULL DEFAULT 'other',
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "action" TEXT,

    CONSTRAINT "share_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "share_link_id" CHAR(26),
    "author_id" CHAR(26),
    "author_name" TEXT,
    "body" TEXT NOT NULL,
    "at_ms" INTEGER,
    "segment_id" CHAR(26),
    "parent_id" CHAR(26),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26),
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "params" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "eta_ms" INTEGER,
    "credit_hold_id" CHAR(26),
    "credits_charged_tenths" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "model" TEXT,
    "cost_minor" INTEGER,
    "egress_bytes" BIGINT,
    "error" JSONB,
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "job_key" TEXT NOT NULL,
    "attempt_id" CHAR(26),
    "max_queue_wait_ms" INTEGER,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_events" (
    "id" CHAR(26) NOT NULL,
    "job_id" CHAR(26) NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" "LogLevel" NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "data" JSONB,

    CONSTRAINT "job_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_submissions" (
    "id" CHAR(26) NOT NULL,
    "job_id" CHAR(26),
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26),
    "media_id" CHAR(26),
    "provider" TEXT NOT NULL,
    "endpoint" TEXT,
    "region" TEXT,
    "external_ref" TEXT,
    "artefact_kind" TEXT NOT NULL,
    "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retention_class" "RetentionClass" NOT NULL DEFAULT 'vendor_default',
    "delete_requested_at" TIMESTAMPTZ(6),
    "delete_confirmed_at" TIMESTAMPTZ(6),

    CONSTRAINT "provider_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_manifests" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "nonce" TEXT NOT NULL,
    "mode" "RenderMode" NOT NULL DEFAULT 'browser',
    "watermark" BOOLEAN NOT NULL DEFAULT true,
    "caps" JSONB NOT NULL DEFAULT '{}',
    "codec_ladder" JSONB NOT NULL DEFAULT '[]',
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "signature" TEXT NOT NULL,

    CONSTRAINT "export_manifests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "job_id" CHAR(26),
    "manifest_id" CHAR(26),
    "kind" "ExportKind" NOT NULL DEFAULT 'mp4',
    "preset" TEXT,
    "bucket" "StorageBucket" NOT NULL DEFAULT 'r2',
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "watermarked" BOOLEAN NOT NULL DEFAULT true,
    "resolution" TEXT,
    "duration_ms" INTEGER,
    "expires_at" TIMESTAMPTZ(6),
    "downloads" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" CHAR(26) NOT NULL,
    "key" "PlanKey" NOT NULL,
    "name" TEXT NOT NULL,
    "prices" JSONB NOT NULL DEFAULT '{}',
    "credits_per_month_tenths" INTEGER NOT NULL DEFAULT 0,
    "seat_price" JSONB,
    "entitlements" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "plan_id" CHAR(26) NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'none',
    "provider_sub_id" TEXT,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "interval" "BillingInterval" NOT NULL DEFAULT 'month',
    "currency" "Currency" NOT NULL DEFAULT 'INR',
    "list_price_minor" INTEGER NOT NULL DEFAULT 0,
    "price_locked_at" TIMESTAMPTZ(6),
    "tax_inclusive" BOOLEAN NOT NULL DEFAULT true,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "renewal_initiate_at" TIMESTAMPTZ(6),
    "grace_until" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "paused_until" TIMESTAMPTZ(6),
    "seats" INTEGER NOT NULL DEFAULT 1,
    "mandate_id" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mandates" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "subscription_id" CHAR(26),
    "provider" "BillingProvider" NOT NULL DEFAULT 'razorpay',
    "provider_mandate_id" TEXT,
    "method" "MandateMethod" NOT NULL,
    "max_amount_minor" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'INR',
    "frequency" "BillingInterval" NOT NULL DEFAULT 'month',
    "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(6),
    "status" "MandateStatus" NOT NULL DEFAULT 'pending',
    "afa_required_per_debit" BOOLEAN NOT NULL DEFAULT false,
    "registered_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "last_notification_at" TIMESTAMPTZ(6),
    "raw" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passes_purchased" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "kind" "PassPurchaseKind" NOT NULL,
    "provider" "BillingProvider" NOT NULL DEFAULT 'razorpay',
    "provider_order_id" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(6),
    "credits_granted_tenths" INTEGER NOT NULL DEFAULT 0,
    "lot_id" CHAR(26),
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passes_purchased_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "subscription_id" CHAR(26),
    "pass_purchase_id" CHAR(26),
    "doc_type" "InvoiceDocType" NOT NULL DEFAULT 'tax_invoice',
    "series" VARCHAR(8) NOT NULL,
    "number" VARCHAR(16) NOT NULL,
    "fiscal_year" VARCHAR(9) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "supplier_legal_name" TEXT NOT NULL,
    "supplier_address" JSONB NOT NULL DEFAULT '{}',
    "supplier_gstin" TEXT,
    "supplier_state_code" VARCHAR(2),
    "supplier_pan" TEXT,
    "recipient_legal_name" TEXT NOT NULL,
    "recipient_email" TEXT,
    "recipient_gstin" TEXT,
    "recipient_address" JSONB NOT NULL DEFAULT '{}',
    "recipient_state_code" VARCHAR(2),
    "recipient_country" CHAR(2) NOT NULL,
    "recipient_tax_id_type" TEXT,
    "recipient_tax_id" TEXT,
    "place_of_supply_state_code" VARCHAR(2),
    "place_of_supply_country" CHAR(2) NOT NULL,
    "supply_type" "SupplyType" NOT NULL,
    "sac_code" VARCHAR(8) NOT NULL,
    "item_description" TEXT NOT NULL,
    "reverse_charge" BOOLEAN NOT NULL DEFAULT false,
    "currency" "Currency" NOT NULL DEFAULT 'INR',
    "exchange_rate_to_inr" DECIMAL(18,6),
    "exchange_rate_at" TIMESTAMPTZ(6),
    "taxable_value_minor" INTEGER NOT NULL DEFAULT 0,
    "discount_minor" INTEGER NOT NULL DEFAULT 0,
    "coupon_code" TEXT,
    "tax_rate_bps" INTEGER NOT NULL DEFAULT 1800,
    "cgst_minor" INTEGER NOT NULL DEFAULT 0,
    "sgst_minor" INTEGER NOT NULL DEFAULT 0,
    "igst_minor" INTEGER NOT NULL DEFAULT 0,
    "cess_minor" INTEGER NOT NULL DEFAULT 0,
    "total_tax_minor" INTEGER NOT NULL DEFAULT 0,
    "total_minor" INTEGER NOT NULL DEFAULT 0,
    "tax_inclusive_display" BOOLEAN NOT NULL DEFAULT true,
    "round_off_minor" INTEGER NOT NULL DEFAULT 0,
    "lut_number" TEXT,
    "export_endorsement_text" TEXT,
    "irn" TEXT,
    "irn_ack_no" TEXT,
    "irn_ack_date" TIMESTAMPTZ(6),
    "signed_qr_payload" TEXT,
    "related_invoice_id" CHAR(26),
    "reason_code" TEXT,
    "signature_key" TEXT,
    "pdf_key" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "gstr1_period" VARCHAR(7),
    "gstr1_reported_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" CHAR(26) NOT NULL,
    "invoice_id" CHAR(26),
    "provider" "BillingProvider" NOT NULL DEFAULT 'razorpay',
    "provider_payment_id" TEXT,
    "method" "PaymentMethod" NOT NULL,
    "mandate_id" CHAR(26),
    "amount_minor" INTEGER NOT NULL,
    "fee_minor" INTEGER NOT NULL DEFAULT 0,
    "fee_tax_minor" INTEGER NOT NULL DEFAULT 0,
    "status" "PaymentStatus" NOT NULL DEFAULT 'created',
    "pre_debit_notified_at" TIMESTAMPTZ(6),
    "scheduled_charge_at" TIMESTAMPTZ(6),
    "attempt_no" INTEGER NOT NULL DEFAULT 1,
    "decline_code" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firc_records" (
    "id" CHAR(26) NOT NULL,
    "payment_id" CHAR(26) NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'razorpay',
    "fira_key" TEXT,
    "foreign_currency" CHAR(3) NOT NULL,
    "foreign_amount_minor" INTEGER NOT NULL,
    "inr_amount_minor" INTEGER NOT NULL,
    "remittance_date" DATE NOT NULL,
    "edf_ref" TEXT,
    "edpms_status" "EdpmsStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firc_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_registrations" (
    "id" CHAR(26) NOT NULL,
    "jurisdiction" CHAR(2) NOT NULL,
    "tax_id_type" TEXT NOT NULL,
    "tax_id" TEXT NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "filing_cadence" TEXT NOT NULL DEFAULT 'monthly',
    "lut_number" TEXT,
    "lut_valid_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_accounts" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "balance_tenths" INTEGER NOT NULL DEFAULT 0,
    "monthly_grant_tenths" INTEGER NOT NULL DEFAULT 0,
    "grant_reset_at" TIMESTAMPTZ(6),
    "negative_allowed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_lots" (
    "id" CHAR(26) NOT NULL,
    "account_id" CHAR(26) NOT NULL,
    "source" "CreditLotSource" NOT NULL,
    "granted_tenths" INTEGER NOT NULL,
    "remaining_tenths" INTEGER NOT NULL,
    "currency" "Currency",
    "amount_minor" INTEGER,
    "fx_rate" DECIMAL(18,6),
    "invoice_id" CHAR(26),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_holds" (
    "id" CHAR(26) NOT NULL,
    "account_id" CHAR(26) NOT NULL,
    "job_id" CHAR(26) NOT NULL,
    "amount_tenths" INTEGER NOT NULL,
    "lot_allocations" JSONB NOT NULL DEFAULT '[]',
    "status" "CreditHoldStatus" NOT NULL DEFAULT 'held',
    "settled_tenths" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger" (
    "id" CHAR(26) NOT NULL,
    "account_id" CHAR(26) NOT NULL,
    "delta_tenths" INTEGER NOT NULL,
    "kind" "CreditLedgerKind" NOT NULL,
    "ref_type" TEXT NOT NULL,
    "ref_id" CHAR(26),
    "lot_id" CHAR(26),
    "balance_after_tenths" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "streak_experiments" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "week_window_start" DATE NOT NULL,
    "publish_days" JSONB NOT NULL DEFAULT '[]',
    "consecutive_weeks" INTEGER NOT NULL DEFAULT 0,
    "frozen" INTEGER NOT NULL DEFAULT 0,
    "holdout" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "streak_experiments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_events" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26),
    "surface" TEXT NOT NULL DEFAULT 'web',
    "export_id" CHAR(26),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "publish_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" CHAR(26) NOT NULL,
    "code" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'percent',
    "percent_off" INTEGER,
    "amount_off_minor" INTEGER,
    "currency" "Currency",
    "applies_to_plans" "PlanKey"[] DEFAULT ARRAY[]::"PlanKey"[],
    "max_redemptions" INTEGER,
    "redemptions" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMPTZ(6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliates" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "code" TEXT NOT NULL,
    "status" "AffiliateStatus" NOT NULL DEFAULT 'pending',
    "country" CHAR(2) NOT NULL DEFAULT 'IN',
    "legal_name" TEXT,
    "pan" TEXT,
    "pan_verified_at" TIMESTAMPTZ(6),
    "gstin" TEXT,
    "payout_method" JSONB NOT NULL DEFAULT '{}',
    "balance_minor" INTEGER NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL DEFAULT 'INR',
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" CHAR(26) NOT NULL,
    "affiliate_id" CHAR(26) NOT NULL,
    "referred_workspace_id" CHAR(26) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'code',
    "first_paid_at" TIMESTAMPTZ(6),
    "status" "ReferralStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commissions" (
    "id" CHAR(26) NOT NULL,
    "referral_id" CHAR(26) NOT NULL,
    "invoice_id" CHAR(26) NOT NULL,
    "gross_minor" INTEGER NOT NULL,
    "rate" INTEGER NOT NULL,
    "fy_label" VARCHAR(9) NOT NULL,
    "tds_section" "TdsSection" NOT NULL DEFAULT '194H',
    "tds_rate_bps" INTEGER NOT NULL DEFAULT 200,
    "tds_amount_minor" INTEGER NOT NULL DEFAULT 0,
    "net_payable_minor" INTEGER NOT NULL DEFAULT 0,
    "gst_on_commission_minor" INTEGER NOT NULL DEFAULT 0,
    "status" "CommissionStatus" NOT NULL DEFAULT 'pending',
    "available_at" TIMESTAMPTZ(6),
    "payout_id" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "commissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "affiliate_fy_totals" (
    "id" CHAR(26) NOT NULL,
    "affiliate_id" CHAR(26) NOT NULL,
    "fy_label" VARCHAR(9) NOT NULL,
    "gross_minor" INTEGER NOT NULL DEFAULT 0,
    "tds_minor" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "affiliate_fy_totals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" CHAR(26) NOT NULL,
    "affiliate_id" CHAR(26) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "tds_total_minor" INTEGER NOT NULL DEFAULT 0,
    "challan_ref" TEXT,
    "form16a_key" TEXT,
    "rail" "PayoutRail" NOT NULL DEFAULT 'upi',
    "provider_ref" TEXT,
    "provider_fee_minor" INTEGER NOT NULL DEFAULT 0,
    "status" "PayoutStatus" NOT NULL DEFAULT 'pending',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_rewards" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "referred_email_hash" TEXT,
    "code" TEXT NOT NULL,
    "credits_tenths" INTEGER NOT NULL DEFAULT 300,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'pending',
    "lot_id" CHAR(26),
    "granted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_lessons" (
    "id" CHAR(26) NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "body" JSONB NOT NULL DEFAULT '{}',
    "duration_min" INTEGER NOT NULL DEFAULT 5,
    "order" INTEGER NOT NULL DEFAULT 0,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_lessons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_progress" (
    "id" CHAR(26) NOT NULL,
    "lesson_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "completed_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelog_entries" (
    "id" CHAR(26) NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" JSONB NOT NULL DEFAULT '{}',
    "version" TEXT,
    "published_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changelog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_articles" (
    "id" CHAR(26) NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'general',
    "body" JSONB NOT NULL DEFAULT '{}',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_flags" (
    "id" CHAR(26) NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rollout_pct" INTEGER NOT NULL DEFAULT 0,
    "targets" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26),
    "actor_id" CHAR(26),
    "actor_kind" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resource_id" CHAR(26),
    "data" JSONB,
    "ip" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disabled_at" TIMESTAMPTZ(6),

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" CHAR(26) NOT NULL,
    "endpoint_id" CHAR(26) NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "response_code" INTEGER,
    "error" TEXT,
    "next_retry_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audio_assets" (
    "id" CHAR(26) NOT NULL,
    "kind" "AudioAssetKind" NOT NULL,
    "provider" "AudioProvider" NOT NULL DEFAULT 'owned',
    "provider_asset_id" TEXT,
    "catalogue_mode" "CatalogueMode" NOT NULL DEFAULT 'mirrored',
    "licence_type" TEXT,
    "licensor" TEXT,
    "licence_ref" TEXT,
    "licence_version" TEXT,
    "territory" TEXT[] DEFAULT ARRAY['WORLD']::TEXT[],
    "term_start" DATE,
    "term_end" DATE,
    "allows_commercial_use" BOOLEAN NOT NULL DEFAULT false,
    "allows_monetisation" BOOLEAN NOT NULL DEFAULT false,
    "allows_paid_ads" BOOLEAN NOT NULL DEFAULT false,
    "allows_broadcast" BOOLEAN NOT NULL DEFAULT false,
    "allows_raw_file_delivery" BOOLEAN NOT NULL DEFAULT false,
    "allows_offline_cache" BOOLEAN NOT NULL DEFAULT false,
    "allows_embedding_index" BOOLEAN NOT NULL DEFAULT false,
    "allows_ai_training" BOOLEAN NOT NULL DEFAULT false,
    "requires_attribution" BOOLEAN NOT NULL DEFAULT false,
    "attribution_text" TEXT,
    "clearance_method" "ClearanceMethod" NOT NULL DEFAULT 'none',
    "content_id_registered" BOOLEAN NOT NULL DEFAULT false,
    "requires_usage_report" BOOLEAN NOT NULL DEFAULT false,
    "report_endpoint" TEXT,
    "max_quality" TEXT,
    "stream_url_ttl_seconds" INTEGER,
    "cost_model" TEXT,
    "licence_proof_key" TEXT,
    "title" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mood" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cue_type" TEXT,
    "bpm" INTEGER,
    "musical_key" TEXT,
    "energy" DOUBLE PRECISION,
    "has_stems" BOOLEAN NOT NULL DEFAULT false,
    "stem_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "intro_ms" INTEGER,
    "outro_ms" INTEGER,
    "vocal_type" TEXT,
    "transient_offset_ms" INTEGER,
    "tail_ms" INTEGER,
    "integrated_lufs" DOUBLE PRECISION,
    "true_peak_db" DOUBLE PRECISION,
    "duration_ms" INTEGER,
    "storage_key" TEXT,
    "embedding" vector(512),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audio_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_usages" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "export_id" CHAR(26),
    "asset_id" CHAR(26) NOT NULL,
    "provider" "AudioProvider" NOT NULL,
    "provider_asset_id" TEXT,
    "surface" "AssetSurface" NOT NULL,
    "placed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exported_at" TIMESTAMPTZ(6),
    "clearance_grant_id" CHAR(26),
    "reported_at" TIMESTAMPTZ(6),
    "report_ref" TEXT,

    CONSTRAINT "asset_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset_clearance_grants" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26),
    "provider" "AudioProvider" NOT NULL,
    "provider_licence_id" TEXT,
    "platform" TEXT NOT NULL,
    "asset_scope" "AssetScope" NOT NULL,
    "public_url" TEXT,
    "partner_user_id" TEXT,
    "status" "ClearanceGrantStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "asset_clearance_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "consent_records_user_id_idx" ON "consent_records"("user_id");

-- CreateIndex
CREATE INDEX "consent_records_purpose_idx" ON "consent_records"("purpose");

-- CreateIndex
CREATE INDEX "consent_records_user_id_purpose_granted_at_idx" ON "consent_records"("user_id", "purpose", "granted_at");

-- CreateIndex
CREATE INDEX "dsr_requests_user_id_idx" ON "dsr_requests"("user_id");

-- CreateIndex
CREATE INDEX "dsr_requests_received_at_idx" ON "dsr_requests"("received_at");

-- CreateIndex
CREATE INDEX "breach_incidents_detected_at_idx" ON "breach_incidents"("detected_at");

-- CreateIndex
CREATE INDEX "access_logs_at_idx" ON "access_logs"("at");

-- CreateIndex
CREATE INDEX "access_logs_actor_id_at_idx" ON "access_logs"("actor_id", "at");

-- CreateIndex
CREATE INDEX "access_logs_workspace_id_at_idx" ON "access_logs"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "identities_user_id_idx" ON "identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "identities_provider_provider_id_key" ON "identities"("provider", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_family_id_idx" ON "sessions"("family_id");

-- CreateIndex
CREATE INDEX "sessions_workspace_id_idx" ON "sessions"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_owner_id_idx" ON "workspaces"("owner_id");

-- CreateIndex
CREATE INDEX "workspaces_billing_country_idx" ON "workspaces"("billing_country");

-- CreateIndex
CREATE INDEX "memberships_workspace_id_idx" ON "memberships"("workspace_id");

-- CreateIndex
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_workspace_id_user_id_key" ON "memberships"("workspace_id", "user_id");

-- CreateIndex
CREATE INDEX "devices_workspace_id_idx" ON "devices"("workspace_id");

-- CreateIndex
CREATE INDEX "devices_fingerprint_idx" ON "devices"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "devices_workspace_id_fingerprint_key" ON "devices"("workspace_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "license_keys_key_key" ON "license_keys"("key");

-- CreateIndex
CREATE INDEX "license_keys_workspace_id_idx" ON "license_keys"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_prefix_key" ON "api_keys"("prefix");

-- CreateIndex
CREATE INDEX "api_keys_workspace_id_idx" ON "api_keys"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_device_code_key" ON "device_codes"("device_code");

-- CreateIndex
CREATE UNIQUE INDEX "device_codes_user_code_key" ON "device_codes"("user_code");

-- CreateIndex
CREATE INDEX "device_codes_expires_at_idx" ON "device_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "bridge_pairings_token_hash_key" ON "bridge_pairings"("token_hash");

-- CreateIndex
CREATE INDEX "bridge_pairings_workspace_id_idx" ON "bridge_pairings"("workspace_id");

-- CreateIndex
CREATE INDEX "bridge_pairings_expires_at_idx" ON "bridge_pairings"("expires_at");

-- CreateIndex
CREATE INDEX "projects_workspace_id_idx" ON "projects"("workspace_id");

-- CreateIndex
CREATE INDEX "projects_last_activity_at_idx" ON "projects"("last_activity_at");

-- CreateIndex
CREATE INDEX "projects_retention_until_idx" ON "projects"("retention_until");

-- CreateIndex
CREATE INDEX "projects_workspace_id_status_last_activity_at_idx" ON "projects"("workspace_id", "status", "last_activity_at");

-- CreateIndex
CREATE INDEX "media_assets_project_id_idx" ON "media_assets"("project_id");

-- CreateIndex
CREATE INDEX "media_assets_content_hash_idx" ON "media_assets"("content_hash");

-- CreateIndex
CREATE INDEX "transcripts_project_id_idx" ON "transcripts"("project_id");

-- CreateIndex
CREATE INDEX "transcript_chunks_transcript_id_idx" ON "transcript_chunks"("transcript_id");

-- CreateIndex
CREATE INDEX "transcript_chunks_transcript_id_revision_idx" ON "transcript_chunks"("transcript_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "transcript_chunks_transcript_id_revision_chunk_idx_key" ON "transcript_chunks"("transcript_id", "revision", "chunk_idx");

-- CreateIndex
CREATE UNIQUE INDEX "edg_documents_project_id_key" ON "edg_documents"("project_id");

-- CreateIndex
CREATE INDEX "edg_segments_edg_id_idx" ON "edg_segments"("edg_id");

-- CreateIndex
CREATE INDEX "edg_segments_edg_id_seq_idx" ON "edg_segments"("edg_id", "seq");

-- CreateIndex
CREATE INDEX "edg_segments_edg_id_start_ms_idx" ON "edg_segments"("edg_id", "start_ms");

-- CreateIndex
CREATE INDEX "edg_passes_edg_id_idx" ON "edg_passes"("edg_id");

-- CreateIndex
CREATE INDEX "edg_pass_items_pass_id_idx" ON "edg_pass_items"("pass_id");

-- CreateIndex
CREATE INDEX "edg_pass_items_edg_id_idx" ON "edg_pass_items"("edg_id");

-- CreateIndex
CREATE INDEX "edg_pass_items_start_ms_idx" ON "edg_pass_items"("start_ms");

-- CreateIndex
CREATE INDEX "edg_pass_items_state_idx" ON "edg_pass_items"("state");

-- CreateIndex
CREATE INDEX "edg_revisions_edg_id_idx" ON "edg_revisions"("edg_id");

-- CreateIndex
CREATE UNIQUE INDEX "edg_revisions_edg_id_revision_key" ON "edg_revisions"("edg_id", "revision");

-- CreateIndex
CREATE INDEX "edg_snapshots_edg_id_idx" ON "edg_snapshots"("edg_id");

-- CreateIndex
CREATE UNIQUE INDEX "edg_snapshots_edg_id_revision_key" ON "edg_snapshots"("edg_id", "revision");

-- CreateIndex
CREATE INDEX "style_presets_key_idx" ON "style_presets"("key");

-- CreateIndex
CREATE UNIQUE INDEX "style_presets_workspace_id_key_key" ON "style_presets"("workspace_id", "key");

-- CreateIndex
CREATE INDEX "brand_kits_workspace_id_idx" ON "brand_kits"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "brand_kits_workspace_id_name_key" ON "brand_kits"("workspace_id", "name");

-- CreateIndex
CREATE INDEX "fonts_workspace_id_idx" ON "fonts"("workspace_id");

-- CreateIndex
CREATE INDEX "memory_entries_workspace_id_idx" ON "memory_entries"("workspace_id");

-- CreateIndex
CREATE INDEX "memory_entries_consent_id_idx" ON "memory_entries"("consent_id");

-- CreateIndex
CREATE INDEX "memory_entries_expires_at_idx" ON "memory_entries"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "share_links_token_key" ON "share_links"("token");

-- CreateIndex
CREATE INDEX "share_links_project_id_idx" ON "share_links"("project_id");

-- CreateIndex
CREATE INDEX "share_links_expires_at_idx" ON "share_links"("expires_at");

-- CreateIndex
CREATE INDEX "share_reports_share_link_id_idx" ON "share_reports"("share_link_id");

-- CreateIndex
CREATE INDEX "share_reports_received_at_idx" ON "share_reports"("received_at");

-- CreateIndex
CREATE INDEX "comments_project_id_idx" ON "comments"("project_id");

-- CreateIndex
CREATE INDEX "comments_share_link_id_idx" ON "comments"("share_link_id");

-- CreateIndex
CREATE INDEX "comments_project_id_at_ms_idx" ON "comments"("project_id", "at_ms");

-- CreateIndex
CREATE INDEX "jobs_workspace_id_idx" ON "jobs"("workspace_id");

-- CreateIndex
CREATE INDEX "jobs_project_id_idx" ON "jobs"("project_id");

-- CreateIndex
CREATE INDEX "jobs_type_idx" ON "jobs"("type");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_job_key_idx" ON "jobs"("job_key");

-- CreateIndex
CREATE INDEX "jobs_workspace_id_status_queued_at_idx" ON "jobs"("workspace_id", "status", "queued_at");

-- CreateIndex
CREATE INDEX "job_events_job_id_idx" ON "job_events"("job_id");

-- CreateIndex
CREATE INDEX "job_events_at_idx" ON "job_events"("at");

-- CreateIndex
CREATE INDEX "provider_submissions_job_id_idx" ON "provider_submissions"("job_id");

-- CreateIndex
CREATE INDEX "provider_submissions_workspace_id_idx" ON "provider_submissions"("workspace_id");

-- CreateIndex
CREATE INDEX "provider_submissions_provider_idx" ON "provider_submissions"("provider");

-- CreateIndex
CREATE UNIQUE INDEX "export_manifests_nonce_key" ON "export_manifests"("nonce");

-- CreateIndex
CREATE INDEX "export_manifests_workspace_id_idx" ON "export_manifests"("workspace_id");

-- CreateIndex
CREATE INDEX "export_manifests_project_id_idx" ON "export_manifests"("project_id");

-- CreateIndex
CREATE INDEX "export_manifests_expires_at_idx" ON "export_manifests"("expires_at");

-- CreateIndex
CREATE INDEX "exports_project_id_idx" ON "exports"("project_id");

-- CreateIndex
CREATE INDEX "exports_expires_at_idx" ON "exports"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "plans_key_key" ON "plans"("key");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_provider_sub_id_key" ON "subscriptions"("provider_sub_id");

-- CreateIndex
CREATE INDEX "subscriptions_workspace_id_idx" ON "subscriptions"("workspace_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

-- CreateIndex
CREATE INDEX "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE INDEX "subscriptions_renewal_initiate_at_idx" ON "subscriptions"("renewal_initiate_at");

-- CreateIndex
CREATE UNIQUE INDEX "mandates_provider_mandate_id_key" ON "mandates"("provider_mandate_id");

-- CreateIndex
CREATE INDEX "mandates_workspace_id_idx" ON "mandates"("workspace_id");

-- CreateIndex
CREATE INDEX "passes_purchased_workspace_id_idx" ON "passes_purchased"("workspace_id");

-- CreateIndex
CREATE INDEX "passes_purchased_ends_at_idx" ON "passes_purchased"("ends_at");

-- CreateIndex
CREATE INDEX "invoices_workspace_id_idx" ON "invoices"("workspace_id");

-- CreateIndex
CREATE INDEX "invoices_fiscal_year_idx" ON "invoices"("fiscal_year");

-- CreateIndex
CREATE INDEX "invoices_number_idx" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_series_fiscal_year_number_key" ON "invoices"("series", "fiscal_year", "number");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_payment_id_key" ON "payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_mandate_id_idx" ON "payments"("mandate_id");

-- CreateIndex
CREATE INDEX "firc_records_payment_id_idx" ON "firc_records"("payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "tax_registrations_jurisdiction_tax_id_type_tax_id_key" ON "tax_registrations"("jurisdiction", "tax_id_type", "tax_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_accounts_workspace_id_key" ON "credit_accounts"("workspace_id");

-- CreateIndex
CREATE INDEX "credit_accounts_grant_reset_at_idx" ON "credit_accounts"("grant_reset_at");

-- CreateIndex
CREATE INDEX "credit_lots_account_id_idx" ON "credit_lots"("account_id");

-- CreateIndex
CREATE INDEX "credit_lots_expires_at_idx" ON "credit_lots"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_job_id_key" ON "credit_holds"("job_id");

-- CreateIndex
CREATE INDEX "credit_holds_account_id_idx" ON "credit_holds"("account_id");

-- CreateIndex
CREATE INDEX "credit_ledger_account_id_idx" ON "credit_ledger"("account_id");

-- CreateIndex
CREATE INDEX "credit_ledger_ref_id_idx" ON "credit_ledger"("ref_id");

-- CreateIndex
CREATE INDEX "credit_ledger_at_idx" ON "credit_ledger"("at");

-- CreateIndex
CREATE UNIQUE INDEX "streak_experiments_workspace_id_key" ON "streak_experiments"("workspace_id");

-- CreateIndex
CREATE INDEX "publish_events_workspace_id_at_idx" ON "publish_events"("workspace_id", "at");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_user_id_key" ON "affiliates"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "affiliates_code_key" ON "affiliates"("code");

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referred_workspace_id_key" ON "referrals"("referred_workspace_id");

-- CreateIndex
CREATE INDEX "referrals_affiliate_id_idx" ON "referrals"("affiliate_id");

-- CreateIndex
CREATE INDEX "commissions_referral_id_idx" ON "commissions"("referral_id");

-- CreateIndex
CREATE INDEX "commissions_invoice_id_idx" ON "commissions"("invoice_id");

-- CreateIndex
CREATE INDEX "commissions_fy_label_idx" ON "commissions"("fy_label");

-- CreateIndex
CREATE UNIQUE INDEX "commissions_referral_id_invoice_id_key" ON "commissions"("referral_id", "invoice_id");

-- CreateIndex
CREATE INDEX "affiliate_fy_totals_affiliate_id_idx" ON "affiliate_fy_totals"("affiliate_id");

-- CreateIndex
CREATE INDEX "affiliate_fy_totals_fy_label_idx" ON "affiliate_fy_totals"("fy_label");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_fy_totals_affiliate_id_fy_label_key" ON "affiliate_fy_totals"("affiliate_id", "fy_label");

-- CreateIndex
CREATE INDEX "payouts_affiliate_id_idx" ON "payouts"("affiliate_id");

-- CreateIndex
CREATE INDEX "referral_rewards_workspace_id_idx" ON "referral_rewards"("workspace_id");

-- CreateIndex
CREATE INDEX "referral_rewards_code_idx" ON "referral_rewards"("code");

-- CreateIndex
CREATE UNIQUE INDEX "academy_lessons_slug_key" ON "academy_lessons"("slug");

-- CreateIndex
CREATE INDEX "lesson_progress_user_id_idx" ON "lesson_progress"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_progress_lesson_id_user_id_key" ON "lesson_progress"("lesson_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "changelog_entries_slug_key" ON "changelog_entries"("slug");

-- CreateIndex
CREATE INDEX "changelog_entries_published_at_idx" ON "changelog_entries"("published_at");

-- CreateIndex
CREATE UNIQUE INDEX "help_articles_slug_key" ON "help_articles"("slug");

-- CreateIndex
CREATE INDEX "help_articles_category_idx" ON "help_articles"("category");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flags_key_key" ON "feature_flags"("key");

-- CreateIndex
CREATE INDEX "audit_log_workspace_id_at_idx" ON "audit_log"("workspace_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_actor_id_at_idx" ON "audit_log"("actor_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_resource_id_idx" ON "audit_log"("resource_id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_workspace_id_idx" ON "webhook_endpoints"("workspace_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpoint_id_idx" ON "webhook_deliveries"("endpoint_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_next_retry_at_idx" ON "webhook_deliveries"("next_retry_at");

-- CreateIndex
CREATE INDEX "audio_assets_kind_idx" ON "audio_assets"("kind");

-- CreateIndex
CREATE INDEX "audio_assets_provider_asset_id_idx" ON "audio_assets"("provider_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "audio_assets_provider_provider_asset_id_key" ON "audio_assets"("provider", "provider_asset_id");

-- CreateIndex
CREATE INDEX "asset_usages_workspace_id_idx" ON "asset_usages"("workspace_id");

-- CreateIndex
CREATE INDEX "asset_usages_project_id_idx" ON "asset_usages"("project_id");

-- CreateIndex
CREATE INDEX "asset_usages_asset_id_idx" ON "asset_usages"("asset_id");

-- CreateIndex
CREATE INDEX "asset_clearance_grants_workspace_id_idx" ON "asset_clearance_grants"("workspace_id");

-- CreateIndex
CREATE INDEX "asset_clearance_grants_provider_licence_id_idx" ON "asset_clearance_grants"("provider_licence_id");

-- CreateIndex
CREATE INDEX "asset_clearance_grants_expires_at_idx" ON "asset_clearance_grants"("expires_at");

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsr_requests" ADD CONSTRAINT "dsr_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_keys" ADD CONSTRAINT "license_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_pairings" ADD CONSTRAINT "bridge_pairings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_pairings" ADD CONSTRAINT "bridge_pairings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_chunks" ADD CONSTRAINT "transcript_chunks_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_documents" ADD CONSTRAINT "edg_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_segments" ADD CONSTRAINT "edg_segments_edg_id_fkey" FOREIGN KEY ("edg_id") REFERENCES "edg_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_passes" ADD CONSTRAINT "edg_passes_edg_id_fkey" FOREIGN KEY ("edg_id") REFERENCES "edg_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_passes" ADD CONSTRAINT "edg_passes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_pass_items" ADD CONSTRAINT "edg_pass_items_pass_id_fkey" FOREIGN KEY ("pass_id") REFERENCES "edg_passes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_pass_items" ADD CONSTRAINT "edg_pass_items_edg_id_fkey" FOREIGN KEY ("edg_id") REFERENCES "edg_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_revisions" ADD CONSTRAINT "edg_revisions_edg_id_fkey" FOREIGN KEY ("edg_id") REFERENCES "edg_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edg_snapshots" ADD CONSTRAINT "edg_snapshots_edg_id_fkey" FOREIGN KEY ("edg_id") REFERENCES "edg_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "style_presets" ADD CONSTRAINT "style_presets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fonts" ADD CONSTRAINT "fonts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "consent_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_reports" ADD CONSTRAINT "share_reports_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_submissions" ADD CONSTRAINT "provider_submissions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_submissions" ADD CONSTRAINT "provider_submissions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_submissions" ADD CONSTRAINT "provider_submissions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_submissions" ADD CONSTRAINT "provider_submissions_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_manifests" ADD CONSTRAINT "export_manifests_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "export_manifests" ADD CONSTRAINT "export_manifests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exports" ADD CONSTRAINT "exports_manifest_id_fkey" FOREIGN KEY ("manifest_id") REFERENCES "export_manifests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_mandate_id_fkey" FOREIGN KEY ("mandate_id") REFERENCES "mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mandates" ADD CONSTRAINT "mandates_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passes_purchased" ADD CONSTRAINT "passes_purchased_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passes_purchased" ADD CONSTRAINT "passes_purchased_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pass_purchase_id_fkey" FOREIGN KEY ("pass_purchase_id") REFERENCES "passes_purchased"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_related_invoice_id_fkey" FOREIGN KEY ("related_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_mandate_id_fkey" FOREIGN KEY ("mandate_id") REFERENCES "mandates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "firc_records" ADD CONSTRAINT "firc_records_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "credit_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "credit_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "credit_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "credit_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "streak_experiments" ADD CONSTRAINT "streak_experiments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_events" ADD CONSTRAINT "publish_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_events" ADD CONSTRAINT "publish_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_workspace_id_fkey" FOREIGN KEY ("referred_workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_fy_totals" ADD CONSTRAINT "affiliate_fy_totals_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_affiliate_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "academy_lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_progress" ADD CONSTRAINT "lesson_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_export_id_fkey" FOREIGN KEY ("export_id") REFERENCES "exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "audio_assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_usages" ADD CONSTRAINT "asset_usages_clearance_grant_id_fkey" FOREIGN KEY ("clearance_grant_id") REFERENCES "asset_clearance_grants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_clearance_grants" ADD CONSTRAINT "asset_clearance_grants_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset_clearance_grants" ADD CONSTRAINT "asset_clearance_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

