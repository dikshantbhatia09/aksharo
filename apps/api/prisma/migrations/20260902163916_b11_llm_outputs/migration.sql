-- CreateTable
CREATE TABLE "llm_outputs" (
    "id" CHAR(26) NOT NULL,
    "project_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "job_id" CHAR(26),
    "kind" TEXT NOT NULL,
    "template_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_outputs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_outputs_project_id_kind_created_at_idx" ON "llm_outputs"("project_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "llm_outputs_workspace_id_idx" ON "llm_outputs"("workspace_id");

-- AddForeignKey
ALTER TABLE "llm_outputs" ADD CONSTRAINT "llm_outputs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_outputs" ADD CONSTRAINT "llm_outputs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_outputs" ADD CONSTRAINT "llm_outputs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
