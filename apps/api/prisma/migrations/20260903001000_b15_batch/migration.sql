-- CreateTable
CREATE TABLE "batches" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "created_by" CHAR(26),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "credits_quoted_tenths" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "batches_workspace_id_idx" ON "batches"("workspace_id");

-- AddForeignKey
ALTER TABLE "batches" ADD CONSTRAINT "batches_workspace_id_fkey"
  FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: projects (B15 brief §4)
ALTER TABLE "projects" ADD COLUMN "batch_id" CHAR(26);

-- CreateIndex
CREATE INDEX "projects_batch_id_idx" ON "projects"("batch_id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_batch_id_fkey"
  FOREIGN KEY ("batch_id") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
