/**
 * Error codes owned by the scripts/translation domain (CONTRACTS §8:
 * `namespace/slug`). `transcript/*`, not `scripts/*`: this is still the
 * transcript's surface, the same convention `transcripts.errors.ts` follows.
 */
export const SCRIPTS_ERROR_CODES = {
  /** The workspace's plan does not cover the requested operation (04 §Plans). */
  planRequired: "transcript/plan_required",
  /** `targets` named a language tag that is not a supported BCP-47-ish tag. */
  invalidTarget: "transcript/invalid_target",
  /** A word in the internal write named a `wid` outside every known chunk. */
  unknownWord: "transcript/unknown_word",
} as const;

export type ScriptsErrorCode = (typeof SCRIPTS_ERROR_CODES)[keyof typeof SCRIPTS_ERROR_CODES];

/** `targets` a translate request may name in one call. */
export const MAX_TRANSLATE_TARGETS = 10;

/** Words a single internal scripts write may carry (one job's worth of a chunk plan). */
export const MAX_INTERNAL_SCRIPTS_WORDS = 200_000;

/** Segments a single internal ops write may carry — mirrors `packages/edg`'s own batch cap. */
export const MAX_INTERNAL_SCRIPTS_SEGMENTS = 500;
