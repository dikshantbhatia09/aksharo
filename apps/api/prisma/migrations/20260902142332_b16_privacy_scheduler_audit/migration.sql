-- CreateEnum
CREATE TYPE "MailSuppressionReason" AS ENUM ('hard_bounce', 'complaint', 'transient');

-- CreateTable
CREATE TABLE "mail_suppressions" (
    "id" CHAR(26) NOT NULL,
    "address_hash" CHAR(64) NOT NULL,
    "reason" "MailSuppressionReason" NOT NULL,
    "until" TIMESTAMPTZ(6),
    "source_event_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mail_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mail_suppressions_address_hash_key" ON "mail_suppressions"("address_hash");

-- CreateIndex
CREATE INDEX "mail_suppressions_reason_idx" ON "mail_suppressions"("reason");
