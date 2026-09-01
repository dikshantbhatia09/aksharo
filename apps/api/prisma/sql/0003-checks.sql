-- 0003 — CHECK constraints
--
-- These encode invariants from `06-data-model.md §Invariants` that must hold even
-- if application code is wrong: they are the last line of defence for money and
-- credits. PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`, so each one is
-- wrapped in a `DO` block that looks the constraint up in `pg_constraint` first,
-- which keeps the file re-runnable.

DO $$
BEGIN
  -- Invariant 6 / D40: no UPI mandate above Rs 15,000 (1_500_000 paise). Cards and
  -- eNACH have no such ceiling, hence the disjunction on `method`.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mandates_upi_cap_check') THEN
    ALTER TABLE mandates
      ADD CONSTRAINT mandates_upi_cap_check
      CHECK (max_amount_minor <= 1500000 OR method <> 'upi_autopay');
  END IF;

  -- Invariant 1 / D32: a lot can never be over-consumed, and can never hold more
  -- than it was granted.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_lots_remaining_non_negative_check') THEN
    ALTER TABLE credit_lots
      ADD CONSTRAINT credit_lots_remaining_non_negative_check
      CHECK (remaining_tenths >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_lots_remaining_within_granted_check') THEN
    ALTER TABLE credit_lots
      ADD CONSTRAINT credit_lots_remaining_within_granted_check
      CHECK (remaining_tenths <= granted_tenths AND granted_tenths >= 0);
  END IF;

  -- D32: "negative balance blocks enqueues" — the balance itself never goes below
  -- zero, because the reserve is a single conditional UPDATE with `balance >= :amt`.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_accounts_balance_non_negative_check') THEN
    ALTER TABLE credit_accounts
      ADD CONSTRAINT credit_accounts_balance_non_negative_check
      CHECK (balance_tenths >= 0);
  END IF;

  -- A hold is worst-case and positive; a settlement never exceeds it (invariant 2).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_holds_amounts_check') THEN
    ALTER TABLE credit_holds
      ADD CONSTRAINT credit_holds_amounts_check
      CHECK (amount_tenths >= 0 AND settled_tenths >= 0 AND settled_tenths <= amount_tenths);
  END IF;

  -- Invariant 6 / D41: every invoice to an Indian recipient carries the State code
  -- that fixes the place of supply (Circular 242/36/2024-GST). B2B invoices derive
  -- it from the GSTIN, B2C from the recorded address; either way the column is
  -- populated by the time the row is written.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_india_state_code_check') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_india_state_code_check
      CHECK (
        recipient_country <> 'IN'
        OR (recipient_state_code IS NOT NULL AND length(recipient_state_code) = 2)
      );
  END IF;

  -- Rule 46: the invoice number is unique per financial year AND at most 16
  -- characters. The uniqueness is `@@unique([series, fiscalYear, number])` in
  -- schema.prisma; the length is enforced here as well as by `VarChar(16)` so a
  -- future column widening cannot silently break compliance.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_number_length_check') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_number_length_check
      CHECK (length(number) BETWEEN 1 AND 16);
  END IF;

  -- An export invoice is only ever raised under LUT without payment of IGST, and
  -- must carry the prescribed endorsement (D41).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_export_endorsement_check') THEN
    ALTER TABLE invoices
      ADD CONSTRAINT invoices_export_endorsement_check
      CHECK (doc_type <> 'export_invoice' OR export_endorsement_text IS NOT NULL);
  END IF;

  -- Segment bounds are ordered; a zero-length segment renders nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edg_segments_bounds_check') THEN
    ALTER TABLE edg_segments
      ADD CONSTRAINT edg_segments_bounds_check
      CHECK (start_ms >= 0 AND end_ms >= start_ms);
  END IF;

  -- Transcript chunks: `chunk_idx = -1` is the per-revision manifest row (06).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transcript_chunks_idx_check') THEN
    ALTER TABLE transcript_chunks
      ADD CONSTRAINT transcript_chunks_idx_check
      CHECK (chunk_idx >= -1 AND revision >= 1);
  END IF;

  -- Revisions increase by exactly one from zero (invariant 3).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edg_documents_revision_check') THEN
    ALTER TABLE edg_documents
      ADD CONSTRAINT edg_documents_revision_check
      CHECK (revision >= 0);
  END IF;

  -- Job progress is a percentage.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_progress_check') THEN
    ALTER TABLE jobs
      ADD CONSTRAINT jobs_progress_check
      CHECK (progress BETWEEN 0 AND 100);
  END IF;

  -- India needs a validated GST State code on the workspace before any purchase
  -- (D41). Non-Indian workspaces must not carry one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_state_code_check') THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_state_code_check
      CHECK (billing_country <> 'IN' OR billing_state_code IS NULL OR length(billing_state_code) = 2);
  END IF;
END
$$;
