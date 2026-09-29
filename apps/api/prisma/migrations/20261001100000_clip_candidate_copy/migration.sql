-- The language model's part in a moment (2026-09-29): the words to post it
-- with (`copy`, `ClipCopySchema` of @montaj/repurpose-contracts: title, hook,
-- description, hashtags, per-platform text) and its reading of the moment
-- (`judgement`: standalone, payoff, humour and topic fit, 0-10 each, and the
-- model that judged it). A clip made from the candidate starts from its copy.
--
-- Purely additive: `copy` defaults to '{}' (no copy), `judgement` is null (no
-- model judged it). Older code never reads either.
--
-- Rollback: ALTER TABLE clip_candidates DROP COLUMN copy, DROP COLUMN judgement;
ALTER TABLE "clip_candidates" ADD COLUMN "copy" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "clip_candidates" ADD COLUMN "judgement" JSONB;
