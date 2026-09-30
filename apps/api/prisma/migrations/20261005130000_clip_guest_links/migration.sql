-- Guest pages (2026-10-05, `apps/api/src/repurpose/guest`): a link a podcaster
-- sends their guest, where the guest downloads the clips they appear in, ready
-- to repost, with no account.
--
--   * `clip_guest_links` - one row per link: the run, the clips it shares (every
--     clip of the run when `all_clips`, else exactly `clip_ids`), the guest's
--     name for the page's greeting, whether the clips' dubbed versions come
--     with them, expiry and revocation, and what it was used for (visits and
--     downloads). The token itself is never stored: `token_hash` is its
--     SHA-256, as `clip_review_links` keeps a review link's.
--
-- Its own table rather than a kind of review link: a review link lets whoever
-- holds it approve clips, and a guest link must never be able to. An API older
-- than this one knows no "kind", and would read every row of
-- `clip_review_links` as a review link.
--
-- Purely additive: one new table; nothing existing is altered, and older code
-- never reads it.
--
-- Rollback:
--   DROP TABLE "clip_guest_links";

-- CreateTable
CREATE TABLE "clip_guest_links" (
    "id" CHAR(26) NOT NULL,
    "workspace_id" CHAR(26) NOT NULL,
    "run_id" CHAR(26) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_hint" TEXT NOT NULL,
    "guest_name" TEXT,
    "all_clips" BOOLEAN NOT NULL DEFAULT false,
    "clip_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "include_dubs" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by" CHAR(26),
    "created_by" CHAR(26),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "last_viewed_at" TIMESTAMPTZ(6),
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "last_downloaded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clip_guest_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clip_guest_links_token_hash_key" ON "clip_guest_links"("token_hash");

-- CreateIndex
CREATE INDEX "clip_guest_links_run_id_idx" ON "clip_guest_links"("run_id");

-- CreateIndex
CREATE INDEX "clip_guest_links_workspace_id_idx" ON "clip_guest_links"("workspace_id");

-- AddForeignKey
ALTER TABLE "clip_guest_links" ADD CONSTRAINT "clip_guest_links_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "repurpose_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
