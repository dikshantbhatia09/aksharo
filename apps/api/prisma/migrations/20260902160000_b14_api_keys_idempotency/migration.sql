-- AlterEnum
BEGIN;
CREATE TYPE "ApiKeyScope_new" AS ENUM ('projects_read', 'projects_write', 'transcripts_read', 'exports_write', 'webhooks_manage');
ALTER TABLE "api_keys" ALTER COLUMN "scopes" TYPE "ApiKeyScope_new"[] USING ("scopes"::text::"ApiKeyScope_new"[]);
ALTER TYPE "ApiKeyScope" RENAME TO "ApiKeyScope_old";
ALTER TYPE "ApiKeyScope_new" RENAME TO "ApiKeyScope";
DROP TYPE "public"."ApiKeyScope_old";
COMMIT;

-- AlterTable
ALTER TABLE "api_keys" ADD COLUMN     "burst_limit" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "created_by" CHAR(26),
ADD COLUMN     "expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "name" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "rotated_from" CHAR(26);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

