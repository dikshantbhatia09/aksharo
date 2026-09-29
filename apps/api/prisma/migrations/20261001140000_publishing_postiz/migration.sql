-- Posting clips through Postiz (2026-09-29, `apps/api/src/publishing`).
--
-- Four columns on the existing publish ledger, nothing else: the tables,
-- enums, checks and the live-idempotency index all shipped with
-- 20260915170000_repurpose_publish and prisma/sql/0008-rep-repurpose-publish.sql.
--
--   * external_media_id / external_media_path: the video as Postiz stored it,
--     written when the upload answers and BEFORE the post is created, so a
--     retry reuses the upload rather than sending the file a second time.
--   * next_check_at / check_no: when the reconciler next asks Postiz what
--     happened to the post, and how many times it has asked; the checks are
--     bounded, and the watchdog enqueues `publish.reconcile` for rows past due.
--
-- Purely additive, nullable or defaulted. Older code never reads them, so a
-- rollback of the API needs no rollback of this migration.
ALTER TABLE "publish_targets"
  ADD COLUMN "external_media_id" TEXT,
  ADD COLUMN "external_media_path" TEXT,
  ADD COLUMN "next_check_at" TIMESTAMPTZ(6),
  ADD COLUMN "check_no" INTEGER NOT NULL DEFAULT 0;
