-- 0007 — B02b `revokeLot` idempotency.
--
-- `refundId` makes a revoke safe to retry (B01's refunds service is at-least-
-- once, same as every worker callback in this system). The ledger row IS the
-- idempotency record: a second call with the same `refundId` must find the
-- first row rather than write a second one, so two CONCURRENT calls — not just
-- sequential retries — cannot both win. A partial unique index over the rows
-- that actually carry a `refundId` (`kind = 'revoke' AND ref_type = 'refund'`)
-- is what makes that a database guarantee rather than a check-then-act race:
-- the second `INSERT` gets a unique-violation, which `LedgerCreditsFacade.
-- revokeLot` catches and answers by re-reading the first row's recorded
-- amount.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'credit_ledger_revoke_refund_unique'
  ) THEN
    CREATE UNIQUE INDEX credit_ledger_revoke_refund_unique
      ON credit_ledger (ref_id)
      WHERE kind = 'revoke' AND ref_type = 'refund';
  END IF;
END
$$;
