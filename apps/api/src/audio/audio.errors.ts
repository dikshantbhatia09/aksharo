/**
 * Error codes owned by the audio-clean domain (CONTRACTS §8: `namespace/slug`),
 * following `transcripts/transcripts.errors.ts`'s convention.
 */
export const AUDIO_ERROR_CODES = {
  /** No media on the project, or it has not been probed, so its duration is unknown. */
  mediaNotReady: "audio/media_not_ready",
  /** No `audio_cleans` row with this id on this project. */
  notFound: "audio/not_found",
  /** A clean run for this media is already queued or running (one live job, CONTRACTS §3). */
  alreadyRunning: "audio/already_running",
  /**
   * An export was asked to apply a clean track (`EdgHot.audio.clean.enabled`)
   * that has no succeeded `audio_cleans` row behind it — A19/A20 refuse rather
   * than silently falling back to the original track (brief §4).
   */
  cleanMissing: "audio/clean_missing",
} as const;

export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[keyof typeof AUDIO_ERROR_CODES];

/** How many `GET /projects/{id}/audio/cleans` returns per page. */
export const AUDIO_CLEAN_PAGE_SIZE = 20;
