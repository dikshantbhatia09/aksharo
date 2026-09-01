-- 0004 — table and column comments
--
-- Retention rules are policy, and policy that lives only in a runbook rots. These
-- comments put the rule next to the data, where `\d+` and every schema browser
-- shows it, so a future migration cannot quietly widen a retention window.
--
-- `COMMENT ON` is idempotent by definition (it replaces).

COMMENT ON TABLE job_events IS
  'Job log lines. RETENTION: the `data` column is purged after 30 days by the daily retention job (06 Retention jobs, D47); rows themselves are kept for the job history.';

COMMENT ON COLUMN job_events.data IS
  'Structured context. RETENTION: nulled after 30 days. Never write personal data or provider credentials here (THREAT-MODEL T21).';

COMMENT ON TABLE access_logs IS
  'Access trail. RETENTION: kept at least 1 year, then purged (D70).';

COMMENT ON TABLE invoices IS
  'Rule 46 billing documents. RETENTION: 72 months, EXEMPT from project purges and from erasure cascades (D41, D47).';

COMMENT ON TABLE credit_ledger IS
  'Append-only. Never UPDATE or DELETE a row: balance corrections are new rows of kind `adjust` or `reversal` (06 invariant 1).';

COMMENT ON TABLE asset_usages IS
  'Append-only usage record for partner reporting and licence audits (D44).';

COMMENT ON TABLE audit_log IS
  'Append-only administrative trail (THREAT-MODEL T20). Erasure writes tombstones here rather than deleting rows.';

COMMENT ON TABLE media_assets IS
  'RETENTION: raw uploads purge 7 days after the last job (`raw_purge_at`); proxy, 16 kHz audio and waveform live for the plan retention period (`derived_purge_at`) so re-render and re-transcribe keep working (D47).';

COMMENT ON TABLE provider_submissions IS
  'Which provider received which artefact, and whether deletion was requested and confirmed. Erasure requests cascade through this registry (D47, THREAT-MODEL T18).';

COMMENT ON COLUMN audio_assets.embedding IS
  'pgvector vector(512) CLAP embedding. Invisible to the Prisma client (Unsupported); read and written by raw SQL only.';

COMMENT ON COLUMN edg_segments.seq IS
  'Fractional index for document ordering (06: numeric). Serialised as a decimal STRING on the wire, because JSON numbers lose precision (CONTRACTS section 2).';

COMMENT ON COLUMN credit_accounts.balance_tenths IS
  'CACHE of the sum of live lot remainders. The ledger is the record; nightly reconciliation is detection only and pages on mismatch (06 invariant 1).';

COMMENT ON COLUMN mandates.max_amount_minor IS
  'Undiscounted list-price cap in minor units. UPI Autopay is capped at 1500000 paise by mandates_upi_cap_check (D40).';

COMMENT ON COLUMN invoices.recipient_state_code IS
  'GST State code. Mandatory for every Indian recipient; enforced by invoices_india_state_code_check (D41).';
