-- D04b: partner catalogue grant fields on `asset_clearance_grants`.
--
-- H-28 (the partner contract) is still open (orchestrator addendum,
-- 2026-09-03): `licence_snapshot` is written with TODO(H-28) placeholder
-- values until it lands, and `PartnerCatalogue` stays behind the
-- `assets.partnerCatalogue` feature flag, default off.

ALTER TABLE "asset_clearance_grants"
  ADD COLUMN "asset_id" CHAR(26),
  ADD COLUMN "use_context" TEXT,
  ADD COLUMN "licence_snapshot" JSONB;

CREATE INDEX "asset_clearance_grants_asset_id_idx" ON "asset_clearance_grants"("asset_id");

ALTER TABLE "asset_clearance_grants"
  ADD CONSTRAINT "asset_clearance_grants_asset_id_fkey"
  FOREIGN KEY ("asset_id") REFERENCES "audio_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
