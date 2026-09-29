-- Brand kit (2026-10-02): a workspace's colours, typefaces, logo and end card,
-- which Autopilot applies to a run's clips when the run says so.
--
-- `brand_kits` has existed since the initial schema and nothing has written to
-- it; v1 keeps one kit per workspace, so it gains a unique index on
-- `workspace_id`, and a pointer to its logo. The logo itself is a
-- `brand_assets` row of kind `logo` (the table the watermark already uses),
-- which gains the image's pixel size.
--
-- Purely additive: two nullable columns, one nullable foreign key, one unique
-- index on a table with no rows. Older code never reads any of them.
--
-- Rollback:
--   ALTER TABLE "brand_kits" DROP CONSTRAINT "brand_kits_logo_asset_id_fkey";
--   DROP INDEX "brand_kits_workspace_id_key";
--   ALTER TABLE "brand_kits" DROP COLUMN "logo_asset_id";
--   ALTER TABLE "brand_assets" DROP COLUMN "width", DROP COLUMN "height";

-- AlterTable
ALTER TABLE "brand_assets" ADD COLUMN "width" INTEGER,
ADD COLUMN "height" INTEGER;

-- AlterTable
ALTER TABLE "brand_kits" ADD COLUMN "logo_asset_id" CHAR(26);

-- CreateIndex
CREATE UNIQUE INDEX "brand_kits_workspace_id_key" ON "brand_kits"("workspace_id");

-- AddForeignKey
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_logo_asset_id_fkey" FOREIGN KEY ("logo_asset_id") REFERENCES "brand_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
