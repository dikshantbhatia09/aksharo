/**
 * Error codes owned by the transcripts domain (CONTRACTS §8: `namespace/slug`).
 *
 * `transcript/*` rather than `transcripts/*`: the namespace names the thing, not
 * the table, which is the convention `edg/*` and `media/*` already follow in
 * `07-api-and-contracts.md §Conventions`.
 */
export const TRANSCRIPT_ERROR_CODES = {
  /** The project has no transcript yet — nothing has been transcribed, or it is still running. */
  notFound: "transcript/not_found",
  /** No media on the project, or it has not been probed, so its duration is unknown. */
  mediaNotReady: "transcript/media_not_ready",
  /** A transcription for this project is already queued or running. */
  alreadyRunning: "transcript/already_running",
  /** Re-transcribing would discard captions the user has edited (brief §6). */
  hasEdits: "transcript/has_edits",
  /** `format` is not one of `json`, `srt`, `vtt`, `txt`. */
  unsupportedFormat: "transcript/unsupported_format",
} as const;

export type TranscriptErrorCode =
  (typeof TRANSCRIPT_ERROR_CODES)[keyof typeof TRANSCRIPT_ERROR_CODES];

/** Chunks returned by one page of `GET /projects/{id}/transcript`. */
export const TRANSCRIPT_CHUNK_PAGE_SIZE = 5;

/** Hard ceiling on the page size a caller may ask for. */
export const MAX_TRANSCRIPT_CHUNK_PAGE_SIZE = 20;

/** Glossary hints a transcribe request may carry; more is a dictionary, not a hint. */
export const MAX_TRANSCRIBE_HINTS = 100;

/** Languages a transcribe request may name. */
export const MAX_TRANSCRIBE_LANGUAGES = 5;
