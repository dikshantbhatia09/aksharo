-- A07: the facts the media worker measures, and why the asset failed when it did.
--
-- `codec`, `has_audio` and `hdr` are written by `media.probe` through the signed
-- `PATCH /internal/media/{id}` allow-list; `failure_reason` carries the
-- user-facing `media/*` code that goes with `status = 'failed'`, so the studio can
-- say "this file is not one we can read" rather than "something went wrong".
--
-- All four are nullable with no default: `NULL` means "not probed yet", which is
-- a different statement from `false`, and backfilling would invent facts about
-- bytes nothing has read.

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "codec" TEXT,
ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "has_audio" BOOLEAN,
ADD COLUMN     "hdr" BOOLEAN;
