-- B13d — orchestrator addendum (after B07b): "chained self-referral" hold,
-- reviewed at POST /admin/referrals/:id/approve|reject before the grant.

ALTER TABLE "referral_rewards" ADD COLUMN "hold_reason" TEXT;
