-- B04: distinguish "paid" from "spent" for a `passes_purchased` row.
--
-- `consumed_at` (B01) is set at payment time by `billing/webhooks.service.ts`'s
-- `grantPass` — a replay guard for the webhook, not a record of the workspace
-- actually spending the pass. For a `first_export` pass those are two different
-- moments (paid at checkout, spent later when a browser export completes), so
-- reusing `consumed_at` for both would make a freshly paid, unspent pass read as
-- already used. `redeemed_at`/`redeemed_manifest_id` record the second event;
-- `OffersModule`'s `NinePassLedger` is the only writer.

ALTER TABLE "passes_purchased"
  ADD COLUMN "redeemed_at" TIMESTAMPTZ(6),
  ADD COLUMN "redeemed_manifest_id" TEXT;

CREATE INDEX "passes_purchased_workspace_id_kind_redeemed_at_idx"
  ON "passes_purchased" ("workspace_id", "kind", "redeemed_at");
