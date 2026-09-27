-- Clips on long videos (2026-09-27): a run processes a WINDOW of its source.
--
-- Plans used to cap a clips run by the source's length (the upload cap,
-- `maxDurationMs`: Free 20 min), so an ordinary 35-minute podcast was refused
-- outright. A run now processes up to `clipsWindowMs` of the video (the most
-- replayed part, the start, or a start the person picks) and "process the next
-- window" is a second run of the same source. `maxSourceDurationMs` is only the
-- abuse ceiling on what may be looked at at all.
--
-- Purely additive: nullable columns and two JSON keys. Older code never reads
-- the columns and ignores the keys.
--
-- The live-source index gains the window start as a key column so the next
-- window of a video can run beside the first. That index is partial and has an
-- expression key, which `schema.prisma` cannot declare, so it is NOT here: it is
-- `prisma/sql/0007z-clips-window-index.sql`, which `db:migrate` applies right
-- after this and re-checks on every run (prisma/sql/README.md). A Prisma
-- migration that carried it would put an index into the shadow database that the
-- schema does not know about, and the next `prisma migrate dev` would scaffold a
-- DROP of it.
--
-- Rollback (after 0007z's own rollback, in that file):
--   ALTER TABLE repurpose_runs DROP COLUMN window_start_ms, DROP COLUMN window_end_ms,
--     DROP COLUMN window_policy, DROP COLUMN source_duration_ms,
--     DROP COLUMN failure_detail, DROP COLUMN source_title;
--   ALTER TABLE media_assets DROP COLUMN source_offset_ms;
--   UPDATE plans SET entitlements = entitlements - 'clipsWindowMs' - 'maxSourceDurationMs';

-- AlterTable
ALTER TABLE "repurpose_runs"
  ADD COLUMN "window_start_ms" INTEGER,
  ADD COLUMN "window_end_ms" INTEGER,
  ADD COLUMN "window_policy" TEXT,
  ADD COLUMN "source_duration_ms" INTEGER,
  ADD COLUMN "failure_detail" JSONB,
  ADD COLUMN "source_title" TEXT;

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN "source_offset_ms" INTEGER;

-- The allowance per plan. The window numbers are today's `maxDurationMs`, so no
-- plan gets less than it had; a database with no plans yet (a fresh one) gets
-- them from `prisma/seed-data.ts` instead, and this updates nothing.
UPDATE "plans" SET "entitlements" = "entitlements" || '{"clipsWindowMs": 1200000, "maxSourceDurationMs": 43200000}'::jsonb WHERE "key" = 'free';
UPDATE "plans" SET "entitlements" = "entitlements" || '{"clipsWindowMs": 3600000, "maxSourceDurationMs": 43200000}'::jsonb WHERE "key" = 'starter';
UPDATE "plans" SET "entitlements" = "entitlements" || '{"clipsWindowMs": 10800000, "maxSourceDurationMs": 43200000}'::jsonb WHERE "key" = 'creator';
UPDATE "plans" SET "entitlements" = "entitlements" || '{"clipsWindowMs": 21600000, "maxSourceDurationMs": 43200000}'::jsonb WHERE "key" = 'studio';
UPDATE "plans" SET "entitlements" = "entitlements" || '{"clipsWindowMs": 21600000, "maxSourceDurationMs": 43200000}'::jsonb WHERE "key" = 'agency';
