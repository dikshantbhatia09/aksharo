-- B02b — `revokeLot`: a lot clawed back before it was spent.
--
-- `reverse()` is keyed on a settled job's hold and inherits ITS lot's expiry —
-- it has nothing to claw back when the money that needs to come out never went
-- through a job at all (a payment refund on an unused top-up or pass lot, B01's
-- refunds service). `revoke` is that third ledger kind: a direct debit against
-- one named lot, never below its remaining balance.

ALTER TYPE "CreditLedgerKind" ADD VALUE 'revoke';
