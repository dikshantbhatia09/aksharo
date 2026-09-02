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
  /**
   * `zoom`/`reframe` need the 540p proxy (CONTRACTS §6, `proxy540.mp4`) to
   * sample frames and audio from (B19b ruling 2); the project's primary
   * media has no `proxyKey` yet.
   */
  proxyRequired: "passes/proxy_required",
} as const;

export type PassErrorCode = (typeof PASS_ERROR_CODES)[keyof typeof PASS_ERROR_CODES];

/** Pacing presets (brief §2); mirrors `worker_ai.passes.autocut.PRESETS`. */
export const AUTOCUT_PRESETS = ["gentle", "standard", "tight"] as const;
export type AutocutPreset = (typeof AUTOCUT_PRESETS)[number];

/** Zoom punch-in presets (B19 §3); mirrors `worker_ai.passes.zoom.ZOOM_PRESETS`. */
export const ZOOM_PRESETS = ["subtle", "standard", "punchy"] as const;
export type ZoomPreset = (typeof ZOOM_PRESETS)[number];

/** Reframe output aspects a `reframe` pass can target (B19 §4). */
export const REFRAME_ASPECTS = ["9:16", "1:1"] as const;
export type ReframeAspect = (typeof REFRAME_ASPECTS)[number];
