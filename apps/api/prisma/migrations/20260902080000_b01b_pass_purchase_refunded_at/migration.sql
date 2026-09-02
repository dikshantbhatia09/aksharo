-- B01b: idempotency marker for the credits clawback on a refunded pass/top-up
-- purchase. `grantPass()` (webhooks.service.ts) is the only place a pass
-- purchase's credits are granted, and it is now the only place they are
-- clawed back — `refunded_at` is the CAS guard that makes a repeated
-- `payment.refunded` webhook or a repeated admin refund call a no-op rather
-- than a second attempt.

ALTER TABLE "passes_purchased"
  ADD COLUMN "refunded_at" TIMESTAMPTZ(6);
