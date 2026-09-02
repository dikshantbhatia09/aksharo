/**
 * Error codes owned by the jobs domain (CONTRACTS §8: `namespace/slug`).
 *
 * They live here rather than in `common/errors/error-codes.ts` because that file
 * holds the codes named in `07-api-and-contracts.md §Conventions`, which is a
 * cross-cutting list; these belong to A08 and A08b extends them.
 */
export const JOB_ERROR_CODES = {
  /** Enqueued worst-case credits would exceed the plan cap (THREAT-MODEL T23). */
  enqueueCap: "jobs/enqueue_cap",
  /** Too many jobs already in flight for this workspace (THREAT-MODEL T23). */
  concurrencyCap: "jobs/concurrency_cap",
  /** Waited longer than `maxQueueWaitMs` in `queued`; the hold was released. */
  queueTimeout: "jobs/queue_timeout",
  /** No such job, or it belongs to another workspace (THREAT-MODEL T5). */
  notFound: "jobs/not_found",
  /** `type` is not one of the CONTRACTS §3 queues. */
  invalidType: "jobs/invalid_type",
  /** The job is not in a state that allows this transition (e.g. cancel a finished job). */
  invalidState: "jobs/invalid_state",
  /** Missing, malformed or wrong `X-Montaj-Signature` (THREAT-MODEL T8). */
  signatureInvalid: "jobs/signature_invalid",
  /** `X-Montaj-Timestamp` outside the replay window (THREAT-MODEL T8). */
  timestampSkew: "jobs/timestamp_skew",
  /** No such dead-letter entry, by entry id or by job id (A08b). */
  dlqNotFound: "jobs/dlq_not_found",
  /** The dead letter has already been replayed or discarded (A08b). */
  dlqAlreadyResolved: "jobs/dlq_already_resolved",
  /** The job is live again, so its dead letter is stale and cannot be replayed. */
  dlqJobNotFailed: "jobs/dlq_job_not_failed",
} as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[keyof typeof JOB_ERROR_CODES];
