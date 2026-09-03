-- AlterEnum
ALTER TYPE "ConsentPurpose" ADD VALUE 'telemetry';

-- CreateTable
CREATE TABLE "crash_reports" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26),
    "user_id" CHAR(26),
    "device_id" CHAR(26),
    "client_kind" TEXT NOT NULL,
    "app_version" TEXT NOT NULL,
    "os_version" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "log_tail" TEXT[],
    "forwarded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crash_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crash_reports_created_at_idx" ON "crash_reports"("created_at");

-- CreateIndex
CREATE INDEX "crash_reports_workspace_id_idx" ON "crash_reports"("workspace_id");

-- CreateIndex
CREATE INDEX "crash_reports_user_id_idx" ON "crash_reports"("user_id");
