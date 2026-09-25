/**
 * Retry, stall and heartbeat policy — the TypeScript copy of A08b's table for
 * this worker.
 *
 * `apps/api/src/jobs/jobs.config.ts` is the source of truth. `attempts` and
 * `backoff` reach a worker inside the BullMQ job options and need no copy;
 * **`lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
 * constructor options** and have to be read from the table by each worker
 * package. This module is that read, and `policies.test.ts` parses the TypeScript
 * source to prove the two have not drifted — the same guard the Python worker's
 * `tests/test_policies.py` gives.
 *
 * {@link heartbeatIntervalMs} is a third of the lock, the standard safety factor,
 * so two consecutive missed beats still leave the lock alive. **The heartbeat is
 * the progress callback**: `JobsService.recordProgress` promotes a `queued` job to
 * `running` precisely so one call does both jobs, which is why a long encode that
 * has nothing new to say still posts its current percentage.
 */

export interface QueuePolicy {
  /** Total tries, not retries: 3 means one run and two retries. */
  readonly attempts: number;
  /** Base delay of the exponential backoff. */
  readonly backoffMs: number;
  /** Fraction of the computed delay to randomise, 0–1 (BullMQ `backoff.jitter`). */
  readonly backoffJitter: number;
  /** How long a worker may hold the job without renewing its lock. */
  readonly lockDurationMs: number;
  /** How often the stalled-job check runs. */
  readonly stalledIntervalMs: number;
  /** How many times a job may be recovered from `stalled` before it is failed. */
  readonly maxStalledCount: number;
}

/** Applied to any queue whose family is not in {@link QUEUE_POLICY_BY_FAMILY}. */
export const DEFAULT_QUEUE_POLICY: QueuePolicy = Object.freeze({
  attempts: 2,
  backoffMs: 10_000,
  backoffJitter: 0.3,
  lockDurationMs: 60_000,
  stalledIntervalMs: 30_000,
  maxStalledCount: 1,
});

/** Per-family defaults, keyed on the part of the queue name before the dot. */
export const QUEUE_POLICY_BY_FAMILY: Readonly<Record<string, QueuePolicy>> = Object.freeze({
  media: {
    attempts: 3,
    backoffMs: 5_000,
    backoffJitter: 0.2,
    lockDurationMs: 120_000,
    stalledIntervalMs: 30_000,
    maxStalledCount: 1,
  },
  ai: {
    attempts: 2,
    backoffMs: 15_000,
    backoffJitter: 0.3,
    lockDurationMs: 120_000,
    stalledIntervalMs: 30_000,
    maxStalledCount: 1,
  },
  render: {
    attempts: 2,
    backoffMs: 30_000,
    backoffJitter: 0.3,
    lockDurationMs: 300_000,
    stalledIntervalMs: 60_000,
    maxStalledCount: 1,
  },
  notify: {
    attempts: 5,
    backoffMs: 2_000,
    backoffJitter: 0.5,
    lockDurationMs: 30_000,
    stalledIntervalMs: 15_000,
    maxStalledCount: 2,
  },
  publish: {
    attempts: 1,
    backoffMs: 30_000,
    backoffJitter: 0.5,
    lockDurationMs: 120_000,
    stalledIntervalMs: 30_000,
    maxStalledCount: 1,
  },
});

/** Queues whose work outlives the family lock. Only the differing fields appear. */
export const QUEUE_POLICY_OVERRIDES: Readonly<Record<string, Partial<QueuePolicy>>> = Object.freeze(
  {
    "media.probe": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "media.proxy": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "media.acquire": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "media.clip": { lockDurationMs: 300_000, stalledIntervalMs: 60_000 },
    "ai.highlights": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.faces": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.transcribe": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.diarise": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.align": { lockDurationMs: 300_000, stalledIntervalMs: 60_000 },
    "render.video": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
  },
);

/** The policy for a queue: its family defaults, with any per-queue override. */
export function queuePolicyFor(queueName: string): QueuePolicy {
  const family = queueName.split(".")[0] ?? queueName;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const base = QUEUE_POLICY_BY_FAMILY[family] ?? DEFAULT_QUEUE_POLICY;
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const override = QUEUE_POLICY_OVERRIDES[queueName];
  return override === undefined ? base : Object.freeze({ ...base, ...override });
}

/** How often a worker on this queue must post progress: a third of the lock. */
export function heartbeatIntervalMs(queueName: string): number {
  return Math.floor(queuePolicyFor(queueName).lockDurationMs / 3);
}

/** BullMQ `Worker` constructor options, so the policy reaches it from one place. */
export function workerOptions(
  queueName: string,
  input: { readonly concurrency: number; readonly prefix: string },
): {
  readonly concurrency: number;
  readonly prefix: string;
  readonly lockDuration: number;
  readonly lockRenewTime: number;
  readonly stalledInterval: number;
  readonly maxStalledCount: number;
} {
  const policy = queuePolicyFor(queueName);
  return {
    concurrency: input.concurrency,
    prefix: input.prefix,
    lockDuration: policy.lockDurationMs,
    // BullMQ renews at half the lock by default; a third matches the heartbeat
    // cadence and leaves room for one missed renewal.
    lockRenewTime: heartbeatIntervalMs(queueName),
    stalledInterval: policy.stalledIntervalMs,
    maxStalledCount: policy.maxStalledCount,
  };
}
