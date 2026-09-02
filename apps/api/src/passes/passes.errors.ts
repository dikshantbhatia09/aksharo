/**
 * Error codes owned by the edit-passes domain (CONTRACTS §8: `namespace/slug`).
 *
 * `pass/*`, matching `transcript/*` and `edg/*`'s own per-domain namespace
 * (`07-api-and-contracts.md §Conventions`).
 */
export const PASS_ERROR_CODES = {
  /** No media on the project, or it has not been probed, so its duration is unknown. */
  mediaNotReady: "pass/media_not_ready",
  /** The project has no transcript yet — autocut needs words to reason about. */
  transcriptNotReady: "pass/transcript_not_ready",
  /** `preset` is not one of `gentle`, `standard`, `tight`. */
  unknownPreset: "pass/unknown_preset",
} as const;

export type PassErrorCode = (typeof PASS_ERROR_CODES)[keyof typeof PASS_ERROR_CODES];

/** Pacing presets (brief §2); mirrors `worker_ai.passes.autocut.PRESETS`. */
export const AUTOCUT_PRESETS = ["gentle", "standard", "tight"] as const;
export type AutocutPreset = (typeof AUTOCUT_PRESETS)[number];
