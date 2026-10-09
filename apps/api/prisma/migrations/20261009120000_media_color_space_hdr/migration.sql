-- Ingestion & Input Engine Pillar 1 §07: 4K HDR Ingestion & Proxy Pipeline
-- Add color space and transfer characteristics to media_assets

ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "color_transfer" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "color_primaries" TEXT;
ALTER TABLE "media_assets" ADD COLUMN IF NOT EXISTS "color_space" TEXT;

