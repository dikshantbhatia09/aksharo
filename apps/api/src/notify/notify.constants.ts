import { redisKeyPrefix } from "../common/redis/redis-keys.js";

import type { BucketSpec } from "../common/guards/rate-limit.service.js";

/**
 * Every number, key and flag the notify module uses, in one place.
 *
 * None of them is an environment variable: CONTRACTS section 1 is the frozen list
 * of *product* configuration, and "how many nudges one mailbox may get in an
 * hour" is a policy that moves through review, not through a deployment's env
 * block. The three mail variables that ARE in the contract choose a transport;
 * they do not tune it.
 */

/**
 * Redis namespace, so a `KEYS montaj:notify:*` in development shows the lot.
 *
 * A function since A23b, for the reason {@link redisKeyPrefix} explains.
 */
export function notifyRedisPrefix(): string {
  return `${redisKeyPrefix()}:notify`;
}

export const notifyRedisKeys = {
  /**
   * Suppression entry for one address, keyed by its SHA-256 so that a Redis dump
   * is not a mailing list (05 section 8: no personal data outside the database).
   */
  suppression: (emailHash: string) => `${notifyRedisPrefix()}:suppressed:${emailHash}`,
  /** The `MAIL_PROVIDER=smtp|ses` delivery receipt, for at-most-once resends. */
  delivered: (idempotencyKey: string) => `${notifyRedisPrefix()}:sent:${idempotencyKey}`,
} as const;

/**
 * How long a delivery receipt is kept.
 *
 * It only has to outlive the retry ladder — five attempts at an exponential
 * two-second backoff is under a minute — but a day costs nothing and covers a
 * queue that was paused over an incident and then drained.
 */
export const DELIVERY_RECEIPT_TTL_SEC = 24 * 60 * 60;

/**
 * A transient bounce is forgiven after a fortnight: a full mailbox empties, a
 * greylisting server relents. A hard bounce or a complaint never is, which is why
 * {@link SUPPRESSION_TTL_SEC} has no entry for them.
 */
export const SUPPRESSION_TTL_SEC: Readonly<Record<string, number | undefined>> = Object.freeze({
  transient: 14 * 24 * 60 * 60,
});

/**
 * Brief section 2: at most ten non-critical messages an hour to one address.
 *
 * The subject is the address hash, so the bucket follows the mailbox rather than
 * the account — three workspaces sharing one address share one bucket, which is
 * the behaviour a mailbox owner experiences anyway.
 */
export const RECIPIENT_RATE_LIMIT: BucketSpec = Object.freeze({
  name: "notify:recipient",
  capacity: 10,
  refillPerSec: 10 / 3600,
});

/** The BullMQ job name every notify job carries; the queue is `notify`. */
export const NOTIFY_JOB_NAME = "notify.send";

/**
 * BullMQ priority for the two lanes. Lower runs first and `0` means
 * "unprioritised", which BullMQ treats as last, so neither lane uses it.
 * A password-reset link waiting behind a batch of low-credit nudges is the
 * failure this prevents.
 */
export const NOTIFY_PRIORITY = Object.freeze({ critical: 1, standard: 5 });

/**
 * The envelope's `workspaceId` when there is not one yet.
 *
 * CONTRACTS section 3 requires a non-empty `workspaceId` on every job, and the
 * first message the platform ever sends a person — the address verification at
 * sign-up — is produced before they belong to anything. A sentinel keeps the
 * envelope valid and is greppable; a blank string would not be.
 */
export const NO_WORKSPACE = "none";

/** Error codes this module adds to CONTRACTS section 8's `namespace/slug` set. */
export const NOTIFY_ERRORS = {
  notFound: "notify/not_found",
  unknownKind: "notify/unknown_kind",
  suppressed: "notify/suppressed",
} as const;

/** Audit actions written to `audit_log` (the durable half of the suppression list). */
export const NOTIFY_AUDIT_ACTIONS = {
  suppressed: "notify.address.suppressed",
  skipped: "notify.send.skipped",
} as const;

/** Default page size for `GET /me/notifications`, and the ceiling on `limit`. */
export const NOTIFICATIONS_PAGE_SIZE = 25;
export const NOTIFICATIONS_MAX_PAGE_SIZE = 100;

/**
 * Turn the in-process `notify` consumer off.
 *
 * The consumer lives inside the API rather than in an `apps/notify` of its own:
 * sending an email is a few hundred milliseconds of I/O with no GPU, no ffmpeg
 * and no model, so a second deployable would be a second thing to roll, watch and
 * page on for work the API is already sized for. The flag exists so a one-shot
 * process (the OpenAPI emitter, a migration) and a test run can boot the same
 * module graph without a worker dialling Redis, exactly as
 * `MONTAJ_SCHEDULER_DISABLED` does for the scheduler.
 *
 * Read from `process.env` rather than the validated `Env` for the same reason
 * `MONTAJ_QUEUE_PREFIX` is: this is deployment naming, not product configuration.
 * Default **on**, because a deployment that forgets it would silently stop
 * sending mail.
 */
export function notifyWorkerEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  const raw = source["NOTIFY_WORKER_ENABLED"]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/** How many jobs the consumer sends at once. Mail is I/O bound and short. */
export const NOTIFY_WORKER_CONCURRENCY = 8;
