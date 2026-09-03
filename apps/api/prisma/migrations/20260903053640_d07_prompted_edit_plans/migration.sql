-- CreateTable
CREATE TABLE "prompted_edit_plans" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "prompt" TEXT NOT NULL,
    "engine" TEXT NOT NULL DEFAULT 'flash',
    "plan_tier" TEXT NOT NULL,
    "plan" JSONB NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "template_version" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planned',
    "source_duration_ms" INTEGER NOT NULL,
    "hold_id" CHAR(26),
    "hold_tenths" INTEGER,
    "settled_tenths" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "prompted_edit_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prompted_edit_plans_project_id_created_at_idx" ON "prompted_edit_plans"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "prompted_edit_plans_workspace_id_idx" ON "prompted_edit_plans"("workspace_id");

-- AddForeignKey
ALTER TABLE "prompted_edit_plans" ADD CONSTRAINT "prompted_edit_plans_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompted_edit_plans" ADD CONSTRAINT "prompted_edit_plans_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
