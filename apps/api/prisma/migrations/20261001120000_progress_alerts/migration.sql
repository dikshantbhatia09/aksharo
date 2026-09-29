-- Progress and alerts (2026-09-29): browsers people turned notifications on
-- in, and which run notifications have already gone out.
--
-- Purely additive: two new tables, nothing existing is altered. Older code
-- never reads either.
--
-- Rollback: DROP TABLE "repurpose_run_notices"; DROP TABLE "push_subscriptions";

-- One browser's Web Push subscription. `endpoint` is the push service URL the
-- browser handed over; `p256dh` and `auth` are the keys a message is encrypted
-- to (RFC 8291), base64url.
CREATE TABLE "push_subscriptions" (
    "id" CHAR(26) NOT NULL,
    "user_id" CHAR(26) NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMPTZ(6),
    "failure_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The run notifications already sent: claimed (inserted) before each send, so
-- a kind goes out once per run.
CREATE TABLE "repurpose_run_notices" (
    "run_id" CHAR(26) NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repurpose_run_notices_pkey" PRIMARY KEY ("run_id","kind")
);

ALTER TABLE "repurpose_run_notices" ADD CONSTRAINT "repurpose_run_notices_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Runs that finished, failed, were stopped or are waiting for their person
-- before this deploy are marked as already told, every kind: the first pass
-- after the deploy would otherwise find each one "due" and send a burst of
-- "your clips are ready" about week-old runs. Runs still working are left
-- unmarked, so they are told when they finish, like any new run.
INSERT INTO "repurpose_run_notices" ("run_id", "kind")
SELECT r."id", k."kind"
FROM "repurpose_runs" r
CROSS JOIN (
    VALUES
        ('clips-ready'),
        ('run-complete'),
        ('run-failed'),
        ('run-needs-you:credits'),
        ('run-needs-you:upload'),
        ('run-needs-you:moments')
) AS k("kind")
WHERE r."status" NOT IN ('draft', 'acquiring', 'preparing_media', 'transcribing', 'analyzing', 'materializing')
ON CONFLICT DO NOTHING;
