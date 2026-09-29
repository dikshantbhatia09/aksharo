-- A clip's image formats (2026-09-29): posts, carousel slides, pins, a
-- thumbnail, covers and banners, taken by `media.stills` from the clip's
-- videos. The column holds the made set: `{ fingerprint, images: [...] }`,
-- where `fingerprint` names the videos they were taken from, so a clip whose
-- captions changed is given new ones.
--
-- Purely additive with a default. Older code never reads it.
ALTER TABLE "repurpose_clips" ADD COLUMN "images" JSONB NOT NULL DEFAULT '{}';
