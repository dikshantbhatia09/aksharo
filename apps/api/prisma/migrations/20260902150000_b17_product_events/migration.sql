-- CreateTable
CREATE TABLE "product_events" (
    "id" CHAR(26) NOT NULL,
    "kind" TEXT NOT NULL,
    "workspace_id" CHAR(26),
    "user_id" CHAR(26),
    "source" TEXT,
    "code_type" TEXT,
    "props" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "product_events_kind_created_at_idx" ON "product_events"("kind", "created_at");

-- CreateIndex
CREATE INDEX "product_events_workspace_id_idx" ON "product_events"("workspace_id");
