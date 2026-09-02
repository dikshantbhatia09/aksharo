-- A12: the EDG module.
--
-- `PassItem.keyframesRef` is frozen in CONTRACTS §2 but `edg_pass_items` only had
-- the `keyframes` bytes column, so an item that points at a stored curve could not
-- round-trip through a `MergePass`. The two word-id indexes serve the working-set
-- read: `DeleteWord` shrinks whichever segments the word bounds, and those are
-- found by word id, not by `seq`.

ALTER TABLE "edg_pass_items" ADD COLUMN "keyframes_ref" TEXT;

CREATE INDEX "edg_segments_edg_id_start_word_id_idx" ON "edg_segments"("edg_id", "start_word_id");
CREATE INDEX "edg_segments_edg_id_end_word_id_idx" ON "edg_segments"("edg_id", "end_word_id");
