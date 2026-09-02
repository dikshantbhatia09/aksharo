-- CreateTable
CREATE TABLE "academy_progress" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "track_id" TEXT NOT NULL,
    "step_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "completed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academy_rewards" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "track_id" TEXT NOT NULL,
    "tenths" INTEGER NOT NULL,
    "lot_id" CHAR(26),
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academy_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelog_dismissals" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "version" TEXT NOT NULL,
    "dismissed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changelog_dismissals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "diagnostics" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "academy_progress_workspace_id_track_id_idx" ON "academy_progress"("workspace_id", "track_id");

-- CreateIndex
CREATE UNIQUE INDEX "academy_progress_workspace_id_user_id_track_id_step_id_key" ON "academy_progress"("workspace_id", "user_id", "track_id", "step_id");

-- CreateIndex
CREATE INDEX "academy_rewards_workspace_id_idx" ON "academy_rewards"("workspace_id");

-- CreateIndex
CREATE UNIQUE INDEX "academy_rewards_workspace_id_track_id_key" ON "academy_rewards"("workspace_id", "track_id");

-- CreateIndex
CREATE UNIQUE INDEX "changelog_dismissals_user_id_key" ON "changelog_dismissals"("user_id");

-- CreateIndex
CREATE INDEX "support_tickets_workspace_id_created_at_idx" ON "support_tickets"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- AddForeignKey
ALTER TABLE "academy_progress" ADD CONSTRAINT "academy_progress_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_progress" ADD CONSTRAINT "academy_progress_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academy_rewards" ADD CONSTRAINT "academy_rewards_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changelog_dismissals" ADD CONSTRAINT "changelog_dismissals_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
