-- Clear the automatic caption-style stamp from segments nobody styled by hand.
--
-- `EdgService.initialise` used to write the project's chosen style onto EVERY
-- segment as well as onto the document. `resolveStyle` reads
-- `segment.styleRef ?? styles.defaultStyleId`, so the segment-level id always
-- won and the document default was unreachable: changing the caption style from
-- the Style gallery updated `defaultStyleId` and the picker showed the new style
-- as selected, while the preview and the export kept drawing the old one. The
-- code no longer stamps; this repairs the documents created while it did.
--
-- A segment that was given its own style by an explicit segment-scope `SetStyle`
-- op is left exactly as it is -- that is a real choice, and it must keep winning
-- over the document default.
UPDATE "edg_segments" AS s
SET "style_ref" = NULL
WHERE s."style_ref" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "edg_revisions" AS r,
         LATERAL jsonb_array_elements(r."ops") AS op
    WHERE r."edg_id" = s."edg_id"
      AND op->>'type' = 'SetStyle'
      AND op->>'scope' = 'segment'
      AND op->>'segmentId' = s."id"
      AND op ? 'styleRef'
  );
