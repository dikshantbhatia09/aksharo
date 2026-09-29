-- Brand kit music and run covers (2026-10-04, audiograms and "your own music").
--
-- A workspace's own music track is a `brand_assets` row of kind `music`, stored
-- at `ws/{workspaceId}/brand/{assetId}.{mp3|wav|m4a}` in the derived store like
-- the logo; the kit points at its current one. It carries what a logo does not:
-- its length, the file's name for the editor's row, and who confirmed, and when,
-- that they have the rights to use it (asked on every upload, and required).
--
-- A run's cover image - the artwork an audio-only source's clips are drawn
-- with - is a `brand_assets` row of kind `cover`; it needs no new column.
-- Keeping both in `brand_assets` is what puts them under workspace erasure,
-- which deletes every brand asset's object and row.
--
-- Purely additive: four nullable columns on `brand_assets`, one nullable
-- foreign key on `brand_kits`. Older code never reads any of them, and never
-- writes a row of kind `music` or `cover`.
--
-- Rollback:
--   ALTER TABLE "brand_kits" DROP CONSTRAINT "brand_kits_music_asset_id_fkey";
--   ALTER TABLE "brand_kits" DROP COLUMN "music_asset_id";
--   ALTER TABLE "brand_assets" DROP COLUMN "duration_ms", DROP COLUMN "title",
--     DROP COLUMN "rights_attested_at", DROP COLUMN "rights_attested_by";
--   (and, first, delete the objects of any `music`/`cover` rows, then those rows)

-- AlterTable
ALTER TABLE "brand_assets" ADD COLUMN "duration_ms" INTEGER,
ADD COLUMN "title" TEXT,
ADD COLUMN "rights_attested_at" TIMESTAMPTZ(6),
ADD COLUMN "rights_attested_by" CHAR(26);

-- AlterTable
ALTER TABLE "brand_kits" ADD COLUMN "music_asset_id" CHAR(26);

-- AddForeignKey
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_music_asset_id_fkey" FOREIGN KEY ("music_asset_id") REFERENCES "brand_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
