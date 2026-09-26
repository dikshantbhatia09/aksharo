/**
 * How this worker says "no", and what the user is told when it does.
 *
 * Two decisions travel with every failure and they are independent:
 *
 * - **Is it retryable?** A network blip reading the source is; a file ffmpeg
 *   cannot decode is not, and retrying it three times is three times the wait for
 *   the same answer. `retryable: false` sends the job straight to the dead-letter
 *   path (`markDeadLetterIfFinal` in `jobs.service.ts`).
 * - **What does the user see?** A `media/*` code from the closed set the API's
 *   allow-list accepts (`MEDIA_FAILURE_REASONS` in `apps/api/src/media`). Only a
 *   *terminal* failure writes one, because an asset marked `failed` while BullMQ
 *   still has retries left is a lie the next attempt has to undo.
 *
 * ffmpeg's own words never reach the user. They reach the *operator*, redacted,
 * as the last few lines of stderr on the job's error — which is where a signed
 * URL would otherwise leak into a database column.
 */

/** The reason codes `PATCH /internal/media/{id}` accepts. Keep in step with the API. */
export const MEDIA_FAILURE_REASONS = [
  "media/unsupported",
  "media/corrupt",
  "media/no_streams",
  "media/too_long",
  "media/probe_failed",
  /** Bigger than the plan allows, even at the smallest acceptable quality. */
  "media/too_large",
  /** The source is private, members-only or needs a sign-in we do not have. */
  "media/source_private",
  /** The source is age-restricted. */
  "media/source_age_restricted",
  /** A live stream (or a premiere that has not finished). */
  "media/source_live",
  /** Deleted, removed by the uploader, or the account is gone. */
  "media/source_removed",
  /** The site refused this server for now (bot check, rate limit). Retry later. */
  "media/source_blocked",
  /** A playlist or channel link rather than one video. */
  "media/source_playlist",
  /** The download failed for a reason we could not name, after its retries. */
  "media/source_failed",
] as const;

export type MediaFailureReason = (typeof MEDIA_FAILURE_REASONS)[number];

export interface MediaFailureOptions {
  /** BullMQ should try again; the default for anything that is not clearly the file. */
  readonly retryable?: boolean;
  /** Written to `media_assets.failure_reason` when the failure is terminal. */
  readonly reason?: MediaFailureReason;
  /** Redacted ffmpeg stderr tail, for the operator. */
  readonly detail?: string;
  readonly cause?: unknown;
}

/** A failure this worker understands well enough to describe. */
export class MediaJobError extends Error {
  public override readonly name = "MediaJobError";
  readonly code: string;
  readonly retryable: boolean;
  readonly reason: MediaFailureReason | undefined;
  readonly detail: string | undefined;

  constructor(code: string, message: string, options: MediaFailureOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? true;
    this.reason = options.reason;
    this.detail = options.detail;
  }
}

/** The file itself is the problem: do not retry, and tell the user which way. */
export function unreadableMedia(
  message: string,
  reason: MediaFailureReason,
  detail?: string,
): MediaJobError {
  return new MediaJobError("media/unreadable", message, {
    retryable: false,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * Everything that might work next time: the store was slow, the signed URL had
 * expired, ffmpeg was killed by the host.
 */
export function transientFailure(
  code: string,
  message: string,
  options: { readonly detail?: string; readonly cause?: unknown } = {},
): MediaJobError {
  return new MediaJobError(code, message, { retryable: true, ...options });
}

/**
 * Strip anything credential-shaped out of a line before it is logged or stored.
 *
 * The source is a **presigned URL**: it carries `X-Amz-Signature` and
 * `X-Amz-Credential` in its query string, and ffmpeg prints the URL it failed to
 * open. Without this, a job's `error` column would hold a working, if short-lived,
 * read capability for a customer's raw footage (THREAT-MODEL T21).
 */
export function redact(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"']+/gi, (url) => {
      const cut = url.indexOf("?");
      return cut === -1 ? url : `${url.slice(0, cut)}?<redacted>`;
    })
    .replace(/\b(X-Amz-[A-Za-z-]+|Signature|Credential)=[^\s&"']+/gi, "$1=<redacted>");
}

/** The last `lines` lines of an ffmpeg stderr buffer, redacted and length-capped. */
export function stderrTail(stderr: string, lines = 12, maxChars = 1_600): string {
  const tail = redact(stderr)
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .join("\n");
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/** A message for a `JobError` body: never longer than the API's 2 000-character cap. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redact(text).slice(0, 2_000) || "failed";
}
