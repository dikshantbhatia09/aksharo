-- Two-speaker layouts (2026-10-01): a podcast clip can show both people, one
-- above the other, instead of half of one.
--
-- `repurpose_clips.layout` is what the person picked on the run page: `auto`
-- (the source's face track decides, `apps/api/src/repurpose/layout.ts`),
-- `single` or `stacked`. `clip_variants.layout` is how that shape's picture was
-- actually cut, written by each `media.clip` completion from its payload's
-- `reframe.layout`; the 4:5 shape follows the 9:16 one, and a clip whose
-- layout changes is cut again.
--
-- Purely additive with defaults: every existing clip reads `auto` and every
-- existing shape `single`, which is what they are. Older code never reads the
-- columns.
--
-- Rollback:
--   ALTER TABLE "clip_variants" DROP COLUMN "layout";
--   ALTER TABLE "repurpose_clips" DROP COLUMN "layout";
--   DROP TYPE "ClipLayout";
--   DROP TYPE "ClipLayoutChoice";

-- CreateEnum
CREATE TYPE "ClipLayoutChoice" AS ENUM ('auto', 'single', 'stacked');

-- CreateEnum
CREATE TYPE "ClipLayout" AS ENUM ('single', 'stacked');

-- AlterTable
ALTER TABLE "repurpose_clips" ADD COLUMN "layout" "ClipLayoutChoice" NOT NULL DEFAULT 'auto';

-- AlterTable
ALTER TABLE "clip_variants" ADD COLUMN "layout" "ClipLayout" NOT NULL DEFAULT 'single';
