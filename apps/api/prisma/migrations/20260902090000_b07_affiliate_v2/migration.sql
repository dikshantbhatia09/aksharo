-- B07 — affiliate v2: application/attribution/commission/TDS/payout/fraud.
--
-- Additive only: A03's affiliates/referrals/commissions/affiliate_fy_totals/
-- payouts tables are untouched in shape; this adds the fraud-review status,
-- click-tracking table, fingerprint columns for self-referral detection, and
-- the per-referral counters the commission schedule (months 1-3 / 4-12,
-- yearly-once, tier switch after 10 active referrals) needs to be idempotent
-- against a re-delivered invoice event.

ALTER TYPE "AffiliateStatus" ADD VALUE 'suspended_review';

ALTER TABLE "affiliates"
  ADD COLUMN "tier" TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN "fraud_flag" TEXT;

ALTER TABLE "referrals"
  ADD COLUMN "ip_hash" TEXT,
  ADD COLUMN "device_hash" TEXT,
  ADD COLUMN "payment_fingerprint" TEXT,
  ADD COLUMN "monthly_paid_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "yearly_commission_paid" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "counts_toward_tier" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "affiliate_clicks" (
  "id" CHAR(26) NOT NULL,
  "affiliate_id" CHAR(26) NOT NULL,
  "code" TEXT NOT NULL,
  "clicked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "attribution_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "ip_hash" TEXT,
  "device_hash" TEXT,

  CONSTRAINT "affiliate_clicks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "affiliate_clicks_affiliate_id_idx" ON "affiliate_clicks"("affiliate_id");
CREATE INDEX "affiliate_clicks_code_idx" ON "affiliate_clicks"("code");

ALTER TABLE "affiliate_clicks"
  ADD CONSTRAINT "affiliate_clicks_affiliate_id_fkey"
  FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Links a discount coupon code to the affiliate it also attributes to
-- (brief §2: "coupons.affiliateId links codes").
ALTER TABLE "coupons" ADD COLUMN "affiliate_id" CHAR(26);
CREATE INDEX "coupons_affiliate_id_idx" ON "coupons"("affiliate_id");
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_affiliate_id_fkey"
  FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
