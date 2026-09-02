-- CreateTable
CREATE TABLE "bridge_sessions" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "device_id" CHAR(26),
    "client_kind" TEXT NOT NULL,
    "connected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnected_at" TIMESTAMPTZ(6),
    "frames_relayed" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bridge_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bridge_sessions_workspace_id_idx" ON "bridge_sessions"("workspace_id");

-- CreateIndex
CREATE INDEX "bridge_sessions_connected_at_idx" ON "bridge_sessions"("connected_at");

-- AddForeignKey
ALTER TABLE "bridge_sessions" ADD CONSTRAINT "bridge_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bridge_sessions" ADD CONSTRAINT "bridge_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
