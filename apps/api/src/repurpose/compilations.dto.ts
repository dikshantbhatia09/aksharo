import { z } from "zod";

import { COMPILATION_LIMITS, SERIES_LIMITS } from "@montaj/repurpose-contracts";

import { zodDto } from "../common/index.js";

/**
 * Request shapes and codes for a run's compilations and series (2026-10-03):
 * `/repurpose/runs/{id}/compilations` and `/repurpose/runs/{id}/series`.
 */

const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

/** The shapes a clip is made in, and so the shapes a compilation can be. */
export const COMPILATION_SHAPES = ["9:16", "4:5", "1:1", "16:9"] as const;
export type CompilationShape = (typeof COMPILATION_SHAPES)[number];

/**
 * `POST /repurpose/runs/{id}/compilations`: the clips in playing order, the
 * shape, and the title card's words (none: no card). The clip list's bounds
 * are the contract's; whether each clip's captioned video is ready is the
 * service's to answer, with the clips that are not.
 */
export const createCompilationSchema = z.object({
  clipIds: z
    .array(ulid)
    .min(COMPILATION_LIMITS.minClips)
    .max(COMPILATION_LIMITS.maxClips)
    .refine((ids) => new Set(ids).size === ids.length, "A clip can be in a compilation once."),
  shape: z.enum(COMPILATION_SHAPES),
  title: z.string().max(COMPILATION_LIMITS.titleMax).optional(),
});
export class CreateCompilationDto extends zodDto(createCompilationSchema) {}
export type CreateCompilationInput = z.infer<typeof createCompilationSchema>;

/** `POST /repurpose/runs/{id}/series`: the clips, numbered in the order they play in the video. */
export const createSeriesSchema = z.object({
  clipIds: z
    .array(ulid)
    .min(SERIES_LIMITS.minClips)
    .max(SERIES_LIMITS.maxClips)
    .refine((ids) => new Set(ids).size === ids.length, "A clip can be in a series once."),
});
export class CreateSeriesDto extends zodDto(createSeriesSchema) {}
export type CreateSeriesInput = z.infer<typeof createSeriesSchema>;

export const COMPILATION_ERRORS = {
  /** A clip is not this run's, was removed, or has no captioned video in the shape yet. */
  clipsNotReady: "repurpose/compilation_clips_not_ready",
  /** The clips, card and fades come to more than {@link COMPILATION_LIMITS.maxOutputMs}. */
  tooLong: "repurpose/compilation_too_long",
  /** "Make again" asked of a compilation that is being made, or is made and current. */
  notRetryable: "repurpose/compilation_not_retryable",
  /** No such compilation on this run. */
  notFound: "repurpose/compilation_not_found",
  /** Failure codes a compilation ends on (`compilation-plan.ts` `compilationFailureOf`). */
  sourceGone: "repurpose/compilation_source_gone",
  cancelled: "repurpose/compilation_cancelled",
  stalled: "repurpose/compilation_stalled",
  failed: "repurpose/compilation_failed",
  noCredits: "repurpose/compilation_no_credits",
} as const;

export const SERIES_ERRORS = {
  /** A clip is not this run's, was removed, or is not made yet. */
  clipsNotReady: "repurpose/series_clips_not_ready",
  /** A clip is already a part of another series; remove that one first. */
  clipTaken: "repurpose/series_clip_taken",
  notFound: "repurpose/series_not_found",
} as const;
