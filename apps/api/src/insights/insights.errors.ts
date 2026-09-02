/**
 * Error codes owned by the insights domain (CONTRACTS §8: `namespace/slug`).
 */
export const INSIGHTS_ERROR_CODES = {
  /** No transcript to build insights from yet. */
  transcriptNotReady: "insights/transcript_not_ready",
  /** `kinds` was empty, or named something other than chapters/summary/hooks. */
  invalidKinds: "insights/invalid_kinds",
  /** The workspace's region has no compliant LLM endpoint configured
   * (brief §2: "block if no compliant region"). Surfaced only if the API can
   * tell ahead of enqueue; the worker enforces it either way. */
  regionNotSupported: "insights/region_not_supported",
} as const;

export type InsightsErrorCode = (typeof INSIGHTS_ERROR_CODES)[keyof typeof INSIGHTS_ERROR_CODES];

/** A request batch may ask for at most one run of each kind. */
export const MAX_INSIGHT_KINDS_PER_REQUEST = 3;

/** Chunk pages read while assembling the transcript sent to the worker (brief §3). */
export const INSIGHTS_TRANSCRIPT_CHUNK_PAGE_LIMIT = 20;

/** Safety cap on how many chunk pages one insights request will read. */
export const INSIGHTS_MAX_CHUNK_PAGES = 50;
