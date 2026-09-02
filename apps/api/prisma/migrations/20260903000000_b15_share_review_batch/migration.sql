-- CreateEnum
CREATE TYPE "ShareLinkScope" AS ENUM ('view', 'comment', 'approve');

-- CreateEnum
CREATE TYPE "ProjectReviewStatus" AS ENUM ('none', 'pending', 'approved', 'changes_requested');

-- AlterTable: share_links (B15 brief §1)
ALTER TABLE "share_links"
  ADD COLUMN "scope" "ShareLinkScope" NOT NULL DEFAULT 'view',
  ADD COLUMN "max_views" INTEGER,
  ADD COLUMN "view_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "client_tag" TEXT,
  ADD COLUMN "auto_disabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: comments (B15 brief §2 — guest identity)
ALTER TABLE "comments"
  ADD COLUMN "author_email_hash" TEXT;

-- AlterTable: projects (B15 brief §2 — approve/request-changes)
ALTER TABLE "projects"
  ADD COLUMN "review_status" "ProjectReviewStatus" NOT NULL DEFAULT 'none';
