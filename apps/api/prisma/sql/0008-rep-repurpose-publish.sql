-- REP-003 / REP-004: constraints and partial indexes Prisma has no syntax for.
--
-- Every statement is idempotent, because `pnpm db:migrate` re-applies this file on
-- every run (prisma/sql/README.md). Constraints are added through a DO block that
-- looks the name up in `pg_constraint` first; indexes use `IF NOT EXISTS`.
--
-- Owner: REP-003 (candidate/clip bounds), REP-004 (publish idempotency).

-- ---------------------------------------------------------------------------
-- Candidate bounds (master plan §6.3)
--
-- The service also checks `end_ms <= source_project.duration_ms` and the run's
-- configured min/max, which the database cannot see. These are the hard limits
-- that must hold whatever the configuration says: a clip that starts before zero
-- or ends before it starts is not a shorter clip, it is a corrupt row.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clip_candidates_start_nonneg_chk') THEN
    ALTER TABLE clip_candidates
      ADD CONSTRAINT clip_candidates_start_nonneg_chk CHECK (start_ms >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clip_candidates_end_after_start_chk') THEN
    ALTER TABLE clip_candidates
      ADD CONSTRAINT clip_candidates_end_after_start_chk CHECK (end_ms > start_ms);
  END IF;

  -- 3-180 s, the configurable range's hard outer bounds (§6.3).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clip_candidates_duration_chk') THEN
    ALTER TABLE clip_candidates
      ADD CONSTRAINT clip_candidates_duration_chk
      CHECK (end_ms - start_ms >= 3000 AND end_ms - start_ms <= 180000);
  END IF;

  -- A manual candidate is never ranked or scored: it was chosen, not proposed
  -- (§10.3). Enforced here so no code path can quietly rank one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clip_candidates_manual_unranked_chk') THEN
    ALTER TABLE clip_candidates
      ADD CONSTRAINT clip_candidates_manual_unranked_chk
      CHECK (source <> 'manual' OR (rank IS NULL AND potential_score IS NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clip_candidates_score_range_chk') THEN
    ALTER TABLE clip_candidates
      ADD CONSTRAINT clip_candidates_score_range_chk
      CHECK (potential_score IS NULL OR (potential_score >= 0 AND potential_score <= 100));
  END IF;

  -- ---------------------------------------------------------------------------
  -- Frozen clip bounds (§6.4)
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repurpose_clips_bounds_chk') THEN
    ALTER TABLE repurpose_clips
      ADD CONSTRAINT repurpose_clips_bounds_chk
      CHECK (source_start_ms >= 0 AND source_end_ms > source_start_ms);
  END IF;

  -- ---------------------------------------------------------------------------
  -- Run progress is a percentage (§6.2)
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repurpose_runs_progress_chk') THEN
    ALTER TABLE repurpose_runs
      ADD CONSTRAINT repurpose_runs_progress_chk CHECK (progress >= 0 AND progress <= 100);
  END IF;

  -- External acquisition requires a recorded rights attestation (§9.3). An upload
  -- needs none, so the rule is conditional on the source kind rather than a NOT
  -- NULL column.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repurpose_runs_rights_chk') THEN
    ALTER TABLE repurpose_runs
      ADD CONSTRAINT repurpose_runs_rights_chk
      CHECK (source_kind = 'upload' OR rights_attested_at IS NOT NULL);
  END IF;

  -- ---------------------------------------------------------------------------
  -- Publish targets (§4.3, §12.6)
  -- ---------------------------------------------------------------------------
  -- A scheduled post without an instant is not a schedule, and a "now" post with
  -- one is a disagreement about what the user confirmed.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_targets_schedule_chk') THEN
    ALTER TABLE publish_targets
      ADD CONSTRAINT publish_targets_schedule_chk
      CHECK ((publish_mode = 'schedule') = (scheduled_at IS NOT NULL));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_targets_attempt_chk') THEN
    ALTER TABLE publish_targets
      ADD CONSTRAINT publish_targets_attempt_chk CHECK (attempt_no >= 0);
  END IF;

  -- A published target must carry the provider reference that proves it (§4.3
  -- step 4). Without this, a lost response could be recorded as success with
  -- nothing to reconcile against.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_targets_published_ref_chk') THEN
    ALTER TABLE publish_targets
      ADD CONSTRAINT publish_targets_published_ref_chk
      CHECK (status <> 'published' OR (external_post_id IS NOT NULL AND published_at IS NOT NULL));
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- One LIVE publish target per (workspace, idempotency key) (§6.8)
--
-- This is the at-most-once rule, in the one place that can actually enforce it.
-- `cancelled` and `failed_permanent` rows are excluded on purpose: they are
-- history, and a deliberate "post again" issues a NEW key that has to be able to
-- coexist with them. A plain UNIQUE would either forbid that or forbid nothing.
--
-- The workspace is part of the key, exactly as it is in repurpose_runs_live_source_idx,
-- channel_connections and the existing `idempotency_records` store. The key is
-- derived from data a tenant supplies, so a globally unique index would let one
-- workspace's live row refuse another workspace's publish — a refusal naming a row
-- the caller cannot see, cannot cancel and did not create — and would let either
-- tenant probe for the other's keys by watching the constraint fire.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS publish_targets_live_idempotency_idx
  ON publish_targets (workspace_id, idempotency_key)
  WHERE status NOT IN ('cancelled', 'failed_permanent');

-- The dispatcher's due-work scan: retryable targets whose backoff has expired.
CREATE INDEX IF NOT EXISTS publish_targets_retry_due_idx
  ON publish_targets (retry_after)
  WHERE status = 'failed_retryable';

-- The reconciler's scan: targets the provider has accepted but not finished.
CREATE INDEX IF NOT EXISTS publish_targets_in_flight_idx
  ON publish_targets (updated_at)
  WHERE status IN ('submitted', 'processing', 'scheduled');

-- ---------------------------------------------------------------------------
-- Active runs (§6.2)
--
-- The list view and the stuck-run runbook both ask "what is still moving in this
-- workspace", which over the full table is a scan of every run ever made.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS repurpose_runs_active_idx
  ON repurpose_runs (workspace_id, updated_at)
  WHERE status NOT IN ('published', 'failed', 'cancelled');

-- One live run per workspace per source fingerprint: pasting the same YouTube URL
-- twice while the first import is still running is the same request, not a second
-- one (§9.5 "ten repeated acquisitions yield one logical source").
CREATE UNIQUE INDEX IF NOT EXISTS repurpose_runs_live_source_idx
  ON repurpose_runs (workspace_id, source_fingerprint)
  WHERE source_fingerprint IS NOT NULL
    AND status NOT IN ('published', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Retention notes recorded next to the data they govern (prisma/sql/README.md)
-- ---------------------------------------------------------------------------
COMMENT ON TABLE repurpose_runs IS
  'REP-003. One guided repurposing run. Retention follows the source project; a workspace deletion cascades. `source_url_encrypted` is the only field that may hold a full external URL and is encrypted at rest.';
COMMENT ON TABLE clip_candidates IS
  'REP-003. Proposed moments. `signals` holds aggregate audio/visual features only - never face identity or inferred personal traits.';
COMMENT ON TABLE channel_connections IS
  'REP-004. Safe references to accounts connected in the licensed publishing service. Provider access and refresh tokens MUST NOT be stored in this database (ADR 0002).';
COMMENT ON TABLE publish_targets IS
  'REP-004. One destination, frozen at user confirmation. (workspace_id, idempotency_key) is unique among live rows via publish_targets_live_idempotency_idx.';
