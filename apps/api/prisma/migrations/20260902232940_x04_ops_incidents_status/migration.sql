-- CreateEnum
CREATE TYPE "OpsIncidentSeverity" AS ENUM ('minor', 'major', 'critical');

-- CreateEnum
CREATE TYPE "OpsIncidentStatus" AS ENUM ('investigating', 'monitoring', 'resolved');

-- CreateTable
CREATE TABLE "ops_incidents" (
    "id" CHAR(26) NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "severity" "OpsIncidentSeverity" NOT NULL DEFAULT 'minor',
    "status" "OpsIncidentStatus" NOT NULL DEFAULT 'investigating',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ops_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ops_status_snapshots" (
    "id" CHAR(26) NOT NULL,
    "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "ops_status_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ops_incidents_status_started_at_idx" ON "ops_incidents"("status", "started_at");

-- CreateIndex
CREATE INDEX "ops_status_snapshots_published_at_idx" ON "ops_status_snapshots"("published_at");
