-- Face-aware caption placement: the derived `faces.json` an `ai.faces` job
-- writes for a video. Additive and nullable; older code never reads it.
--
-- Rollback: ALTER TABLE media_assets DROP COLUMN faces_key;
ALTER TABLE "media_assets" ADD COLUMN "faces_key" TEXT;
