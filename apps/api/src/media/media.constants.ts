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
