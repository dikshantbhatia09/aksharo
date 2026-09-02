-- B07b: give-get referral loop.
--
-- Reshapes A03's `referral_rewards` (unused by any application code — grep
-- confirms no reads/writes outside this migration and the model definition)
-- from a one-sided "workspace + email hash" record into the two-workspace
-- shape the brief specifies: `referrerWorkspaceId`, `referredWorkspaceId`
-- (unique — one referral per referred workspace, which is what makes the
-- first-export grant exactly-once), separate lot ids for each side, a
-- `reason` for a rejection, and the abuse fingerprints (`device_hash`,
-- `ip_hash`, THREAT-MODEL T17). `revoked` is replaced by `rejected` (the
-- brief's state machine has no revoke path).
--
-- Also adds the personal per-workspace referral code (`AK-XXXXXX`) and the
-- once-only tiered-bonus marker, both on `workspaces`, next to the existing
-- `signup_gift_consumed_at` guard column they're modelled on.

ALTER TABLE "workspaces"
  ADD COLUMN "referral_code" TEXT,
  ADD COLUMN "referral_bonus_granted_at" TIMESTAMPTZ(6),
  ADD COLUMN "referral_prompt_shown_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "workspaces_referral_code_key" ON "workspaces"("referral_code");

-- Drop and recreate `referral_rewards` — no production data exists for this
-- unused table (safe in every environment this migration runs against).
DROP TABLE "referral_rewards";
DROP TYPE "ReferralRewardStatus";
CREATE TYPE "ReferralRewardStatus" AS ENUM ('pending', 'granted', 'rejected');

CREATE TABLE "referral_rewards" (
    "id" CHAR(26) NOT NULL,
    "referrer_workspace_id" CHAR(26) NOT NULL,
    "referred_workspace_id" CHAR(26) NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ReferralRewardStatus" NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "granted_at" TIMESTAMPTZ(6),
    "referrer_lot_id" CHAR(26),
    "referred_lot_id" CHAR(26),
    "device_hash" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_rewards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_rewards_referred_workspace_id_key" ON "referral_rewards"("referred_workspace_id");
CREATE INDEX "referral_rewards_referrer_workspace_id_idx" ON "referral_rewards"("referrer_workspace_id");
CREATE INDEX "referral_rewards_code_idx" ON "referral_rewards"("code");

ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referrer_workspace_id_fkey" FOREIGN KEY ("referrer_workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referred_workspace_id_fkey" FOREIGN KEY ("referred_workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
