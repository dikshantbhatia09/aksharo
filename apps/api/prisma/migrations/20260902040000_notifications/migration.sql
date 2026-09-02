-- A25 — in-app notifications (the bell in the app shell).
--
-- One row per thing a signed-in user should be able to find again after the
-- email has been archived. `kind` is a free string, not an enum, for the same
-- reason `jobs.type` is: the closed set lives in `src/notify/notify.kinds.ts`
-- and adding a template must not be a migration.
--
-- Both foreign keys cascade on delete: erasure (05 section 9) has to take the
-- bell with it, and a deleted workspace has no notifications worth keeping.

CREATE TABLE "notifications" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26),
    "kind" TEXT NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- The bell's own query: one user's rows, newest first.
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");

-- The unread badge. Postgres indexes NULLs, so `read_at IS NULL` uses this.
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

CREATE INDEX "notifications_workspace_id_idx" ON "notifications"("workspace_id");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
