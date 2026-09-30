-- B-roll library (2026-10-05): a workspace's own pictures, cut away to over the
-- words that name them (`EdgHot.overlays`, kind `b-roll`).
--
-- One row per picture, uploaded by a person or saved from a stock photo search
-- (Pexels, when `PEXELS_API_KEY` is set), with the words it is matched on
-- (`tags`), its pixel size (measured on save, so a renderer sizes it without
-- decoding it) and, for a stock photo, where it came from and its
-- photographer's credit. The bytes live at
-- `ws/{workspace_id}/broll/{id}.{png|jpg|webp}` in the derived store, the only
-- folder a render reads a cutaway's picture from. `(workspace_id, source,
-- source_ref)` is unique, so a stock photo is saved into a library once
-- (uploads have no `source_ref`, and NULLs never collide).
--
-- The workspace erasure cascade deletes the objects and then the rows; nothing
-- else ever deletes a row but the person.
--
-- Purely additive: one new table. Older code never reads it.
--
-- Rollback:
--   (first delete the objects under each row's `storage_key`, or they are left
--   behind with nothing naming them)
--   DROP TABLE "broll_assets";

-- CreateTable
CREATE TABLE "broll_assets" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "title" TEXT,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "source_ref" TEXT,
    "credit" JSONB,
    "created_by" CHAR(26),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broll_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "broll_assets_workspace_id_created_at_idx" ON "broll_assets"("workspace_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "broll_assets_workspace_id_source_source_ref_key" ON "broll_assets"("workspace_id", "source", "source_ref");

-- AddForeignKey
ALTER TABLE "broll_assets" ADD CONSTRAINT "broll_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
