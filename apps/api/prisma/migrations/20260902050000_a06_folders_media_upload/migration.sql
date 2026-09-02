-- A06: project folders, and the columns the media upload path needs.
--
-- 06-data-model.md lists `projects.folder_id` but has no `folders` table, so A03
-- left the column without a foreign key. This migration introduces the table and
-- converts the column. Nothing has written a folder id yet (A06 is the first work
-- package with a folders API), but the FK is added after an explicit clear so the
-- statement cannot fail on a database somebody wrote one into by hand.

-- AlterEnum
ALTER TYPE "MediaRole" ADD VALUE 'subtitle';

-- AlterTable
ALTER TABLE "media_assets" ADD COLUMN     "derived_purged_at" TIMESTAMPTZ(6),
ADD COLUMN     "filename" TEXT,
ADD COLUMN     "needs_realign" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "part_size_bytes" INTEGER,
ADD COLUMN     "raw_purged_at" TIMESTAMPTZ(6),
ADD COLUMN     "thumb_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "upload_id" TEXT;

-- CreateTable
CREATE TABLE "folders" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" CHAR(26),
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "folders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "folders_workspace_id_idx" ON "folders"("workspace_id");

-- CreateIndex
CREATE INDEX "folders_workspace_id_parent_id_idx" ON "folders"("workspace_id", "parent_id");

-- CreateIndex
CREATE INDEX "media_assets_raw_purge_at_idx" ON "media_assets"("raw_purge_at");

-- CreateIndex
CREATE INDEX "media_assets_derived_purge_at_idx" ON "media_assets"("derived_purge_at");

-- CreateIndex
CREATE INDEX "projects_workspace_id_folder_id_idx" ON "projects"("workspace_id", "folder_id");

-- CreateIndex
CREATE INDEX "projects_workspace_id_client_tag_idx" ON "projects"("workspace_id", "client_tag");

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "folders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Convert `projects.folder_id` into a real reference (see the note at the top).
UPDATE "projects" SET "folder_id" = NULL WHERE "folder_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
