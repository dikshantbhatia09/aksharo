-- 0002 — indexes Prisma cannot express
--
-- Everything here is either a PARTIAL index (a `WHERE` predicate), an index with
-- an explicit NULL ordering, or a vector index. Plain composite indexes and unique
-- constraints from 06-data-model.md live in `schema.prisma` instead, so that
-- `prisma migrate diff` sees them and nothing is declared twice; the A03 test
-- `prisma/sql.spec.ts` asserts that BOTH sets exist by name, wherever they came
-- from. The named Prisma-side indexes the brief calls out are:
--
--   edg_segments (edg_id, seq)                       -> @@index in schema.prisma
--   transcript_chunks (transcript_id, revision, chunk_idx) UNIQUE -> @@unique
--   invoices (series, fiscal_year, number) UNIQUE     -> @@unique
--
-- and the fourth, `credit_lots (account_id, expires_at NULLS LAST, created_at)`,
-- is below: Prisma has no syntax for a NULL ordering.
--
-- Every statement is idempotent (`IF NOT EXISTS`), so this file is re-applied on
-- every `pnpm db:migrate`.

-- ---------------------------------------------------------------------------
-- Credits — the lot consumption order of D32: soonest-expiring first, then FIFO.
-- ASC already puts NULLs last in PostgreSQL; it is written out because the order
-- IS the invariant (non-expiring top-ups must be spent after expiring grants).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS credit_lots_consumption_order_idx
  ON credit_lots (account_id, expires_at ASC NULLS LAST, created_at ASC)
  WHERE remaining_tenths > 0;

-- Open holds only: the settlement path and the reconciliation report scan these.
CREATE INDEX IF NOT EXISTS credit_holds_open_idx
  ON credit_holds (account_id, at)
  WHERE status = 'held';

-- Grant reset sweep (daily retention job).
CREATE INDEX IF NOT EXISTS credit_accounts_grant_reset_due_idx
  ON credit_accounts (grant_reset_at)
  WHERE grant_reset_at IS NOT NULL;

-- Lot expiry sweep.
CREATE INDEX IF NOT EXISTS credit_lots_expiry_due_idx
  ON credit_lots (expires_at)
  WHERE expires_at IS NOT NULL AND remaining_tenths > 0;

-- ---------------------------------------------------------------------------
-- Auth — live sessions and pending device codes are tiny slices of large tables.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS sessions_live_family_idx
  ON sessions (family_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS sessions_live_user_idx
  ON sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS device_codes_pending_idx
  ON device_codes (expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS bridge_pairings_live_idx
  ON bridge_pairings (workspace_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS devices_active_lease_idx
  ON devices (workspace_id, lease_until)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS license_keys_live_idx
  ON license_keys (workspace_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS api_keys_live_idx
  ON api_keys (workspace_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Retention sweeps (D47). Each one is a "due now" query over a mostly-NULL column.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS media_assets_raw_purge_due_idx
  ON media_assets (raw_purge_at)
  WHERE raw_purge_at IS NOT NULL AND status <> 'purged';

CREATE INDEX IF NOT EXISTS media_assets_derived_purge_due_idx
  ON media_assets (derived_purge_at)
  WHERE derived_purge_at IS NOT NULL AND status <> 'purged';

CREATE INDEX IF NOT EXISTS projects_retention_due_idx
  ON projects (retention_until)
  WHERE deleted_at IS NULL AND retention_until IS NOT NULL;

CREATE INDEX IF NOT EXISTS exports_expiry_due_idx
  ON exports (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS export_manifests_unconsumed_idx
  ON export_manifests (expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS memory_entries_expiry_due_idx
  ON memory_entries (expires_at);

CREATE INDEX IF NOT EXISTS asset_clearance_grants_live_idx
  ON asset_clearance_grants (workspace_id, expires_at)
  WHERE revoked_at IS NULL;

-- `job_events.data` is purged after 30 days; the sweep is a range scan on `at`.
CREATE INDEX IF NOT EXISTS job_events_data_purge_idx
  ON job_events (at)
  WHERE data IS NOT NULL;

-- Provider deletion follow-ups (D47, THREAT-MODEL T18).
CREATE INDEX IF NOT EXISTS provider_submissions_deletion_pending_idx
  ON provider_submissions (submitted_at)
  WHERE delete_confirmed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Editing — the proposal review queue and the segment read path.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS edg_pass_items_proposed_idx
  ON edg_pass_items (edg_id, start_ms)
  WHERE state = 'proposed';

-- Live (non-tombstoned) segments in document order. Complements the plain
-- `(edg_id, seq)` index declared in schema.prisma, which the editor pages through.
CREATE INDEX IF NOT EXISTS edg_segments_live_seq_idx
  ON edg_segments (edg_id, seq)
  WHERE deleted_at_rev IS NULL;

-- ---------------------------------------------------------------------------
-- Billing — renewal initiation runs at least 48 h before the period end (D40).
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS subscriptions_renewal_due_idx
  ON subscriptions (renewal_initiate_at)
  WHERE status IN ('active', 'past_due') AND renewal_initiate_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS subscriptions_period_end_idx
  ON subscriptions (current_period_end)
  WHERE status IN ('active', 'past_due', 'trialing');

CREATE INDEX IF NOT EXISTS mandates_live_idx
  ON mandates (workspace_id, valid_until)
  WHERE revoked_at IS NULL;

-- Commission maturation (30-day hold) and payout batching.
CREATE INDEX IF NOT EXISTS commissions_payable_idx
  ON commissions (available_at)
  WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Moderation — open share-link reports against their statutory deadline.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS share_reports_open_idx
  ON share_reports (due_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS share_links_live_idx
  ON share_links (project_id, expires_at)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Jobs — admission control and the queue-wait watchdog read live jobs only.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS jobs_live_workspace_idx
  ON jobs (workspace_id, queued_at)
  WHERE status IN ('queued', 'running');

-- One live job per dedupe key (CONTRACTS §3 `jobKey`).
CREATE UNIQUE INDEX IF NOT EXISTS jobs_live_job_key_key
  ON jobs (job_key)
  WHERE status IN ('queued', 'running');

-- ---------------------------------------------------------------------------
-- Vector search — CLAP audio embeddings (D44). Cosine distance; HNSW because the
-- catalogue is small and read-heavy and needs no training step like IVFFlat.
-- Only assets whose licence permits embedding indexing are ever inserted, but the
-- predicate is stated so the index cannot outlive a licence change.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS audio_assets_embedding_hnsw_idx
  ON audio_assets USING hnsw (embedding vector_cosine_ops)
  WHERE allows_embedding_index = true;

-- Licence-aware retrieval filters BEFORE ranking (D44): the common pre-filter.
CREATE INDEX IF NOT EXISTS audio_assets_licence_filter_idx
  ON audio_assets (kind, provider, allows_commercial_use, allows_monetisation)
  WHERE allows_embedding_index = true;

-- ---------------------------------------------------------------------------
-- Uniqueness that a plain UNIQUE constraint cannot give, because PostgreSQL
-- treats every NULL as distinct: `UNIQUE (workspace_id, key)` does NOT stop two
-- SYSTEM style presets (workspace_id IS NULL) sharing a key. The `@@unique` in
-- schema.prisma covers workspace-owned rows; these cover the NULL side.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS style_presets_system_key_key
  ON style_presets (key)
  WHERE workspace_id IS NULL;

-- One live invitation per email per workspace (accepted invitations carry a
-- user_id and are covered by the `@@unique([workspaceId, userId])` constraint).
CREATE UNIQUE INDEX IF NOT EXISTS memberships_open_invite_key
  ON memberships (workspace_id, invited_email)
  WHERE user_id IS NULL AND status = 'invited';
