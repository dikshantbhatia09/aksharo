/**
 * Job keys and credit quotes for the jobs the media path produces.
 *
 * `jobKey` is the deduplication key `JobsService.enqueue` enforces one live job
 * per `(workspace, key)` on, so it names the *unit of work* and not the request:
 * two `complete` calls for one media item must produce one probe, and a replace
 * that lands while the first probe is still queued must not produce a second.
 */
export const MEDIA_JOB_KEYS = {
  probe: (mediaId: string): string => `media.probe:${mediaId}`,
  proxy: (mediaId: string): string => `media.proxy:${mediaId}`,
  align: (mediaId: string): string => `ai.align:${mediaId}`,
} as const;

/**
 * Worst-case credit holds, in tenths (CONTRACTS §4).
 *
 * **Zero, and deliberately so.** `04-pricing-and-monetization.md` bills
 * transcription, translation, audio clean, passes and cloud renders; probing an
 * upload and making a 540p proxy are the cost of storing the file at all and are
 * priced into the plan. A non-zero hold here would charge a user for uploading.
 *
 * The call still goes through `CreditsFacade.reserve` — every producer must
 * (CONTRACTS §4) — so admission control, the audit trail and B02's ledger all see
 * the job; the amount is simply nothing.
 */
export const MEDIA_JOB_QUOTES = {
  probeTenths: 0,
  proxyTenths: 0,
  /**
   * Aligning an imported subtitle against existing audio. The media minutes were
   * already paid for at transcription; A11 owns the real quote and will set it
   * from `BURN_RATES` when it takes the align path over.
   */
  alignTenths: 0,
} as const;

/**
 * Why a media asset is `failed`, in the user's words (CONTRACTS §8: `namespace/slug`).
 *
 * A **closed set**, not free text. `media_assets.failure_reason` is rendered in
 * the studio, and the only thing that ever writes it is a worker reporting through
 * the signed patch — so an open string would be a worker-controlled sentence on a
 * user's screen. The studio maps each code to translated copy; anything not on
 * this list is refused by `MediaPatchSchema` and the asset simply reads "failed".
 *
 * `media/too_long` is the one the API writes itself: the plan's duration cap is
 * policy, and the probe completion handler applies it (A07).
 */
export const MEDIA_FAILURE_REASONS = [
  /** ffprobe read the file and found nothing it can decode. */
  "media/unsupported",
  /** The bytes are truncated or damaged — a half-finished upload, usually. */
  "media/corrupt",
  /** A readable container with neither an audio nor a video stream. */
  "media/no_streams",
  /** Longer than the plan allows; the probe succeeded and the pipeline stopped. */
  "media/too_long",
  /** Terminal, and none of the above. The job event carries the detail. */
  "media/probe_failed",
] as const;

export type MediaFailureReason = (typeof MEDIA_FAILURE_REASONS)[number];
