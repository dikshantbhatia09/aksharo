-- Highlight Discovery & Virality Engine Pillar 2 §02: Scoring Diagnostic Rationale
-- Add diagnostic JSONB column to clip_candidates

ALTER TABLE "clip_candidates" ADD COLUMN IF NOT EXISTS "diagnostic" JSONB;

