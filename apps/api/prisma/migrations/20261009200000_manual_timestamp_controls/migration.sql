-- Highlight Discovery & Virality Engine Pillar 2 §08: Manual Timestamp Controls
-- Add manual override boundary columns to repurpose_clips

ALTER TABLE "repurpose_clips" ADD COLUMN IF NOT EXISTS "is_manual_override" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "repurpose_clips" ADD COLUMN IF NOT EXISTS "manual_start_sec" DOUBLE PRECISION;
ALTER TABLE "repurpose_clips" ADD COLUMN IF NOT EXISTS "manual_end_sec" DOUBLE PRECISION;

