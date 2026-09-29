import { z } from "zod";

import { CLIP_LAYOUT_CHOICES } from "./layout.js";
import { zodDto } from "../common/index.js";

/**
 * Request shapes and codes for steering a run's moments after discovery
 * (2026-09-29): remove one, bring it back, move its start and end.
 *
 * As with `repurpose-clips.dto.ts`, the times are only checked for being
 * numbers here: a moment that cannot be cut (too short, too long, outside the
 * video) is answered with `repurpose/clip_bounds_invalid`, which the page has a
 * sentence for, once the times have been snapped to the words.
 */

/** `PATCH /repurpose/runs/{id}/candidates/{candidateId}` - the moment's new times. */
export const adjustCandidateSchema = z.object({
  startMs: z.number().finite(),
  endMs: z.number().finite(),
});
export class AdjustCandidateDto extends zodDto(adjustCandidateSchema) {}
export type AdjustCandidateInput = z.infer<typeof adjustCandidateSchema>;

/**
 * `PUT /repurpose/runs/{id}/clips/{clipId}/layout` (two-speaker layouts,
 * 2026-10-01): "Auto", "One speaker" or "Both speakers" for one clip.
 */
export const clipLayoutSchema = z.object({
  layout: z.enum(CLIP_LAYOUT_CHOICES),
});
export class ClipLayoutDto extends zodDto(clipLayoutSchema) {}
export type ClipLayoutInput = z.infer<typeof clipLayoutSchema>;

export const REPURPOSE_STEERING_ERRORS = {
  /** Another moment of the run already has exactly these times (candidates are unique on them). */
  boundsTaken: "repurpose/clip_bounds_taken",
  /**
   * The clip is being cut right now: a cut of the old times finishing after
   * the new one would leave the old picture in its place.
   */
  clipBusy: "repurpose/clip_busy",
  /** The moment was removed: bring it back before changing its times. */
  candidateRemoved: "repurpose/candidate_removed",
} as const;
