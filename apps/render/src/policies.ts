/**
 * Retry, stall and heartbeat policy — the render service's copy of A08b's table.
 *
 * `apps/api/src/jobs/jobs.config.ts` is the source of truth. `attempts` and
 * `backoff` reach a worker inside the BullMQ job options and need no copy;
 * `lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
 * constructor options and have to be read from the table by each worker package.
 * This module is that read, and `policies.test.ts` parses the TypeScript source
 * to prove the two have not drifted — the same guard `apps/worker-ai` carries.
 *
 * Why the render numbers are what they are: a re-render costs CPU minutes and a
 * failing one usually fails again, so `render.video` retries least (two tries)
 * and backs off most (30 s). Its lock is **ten minutes**, because a 4K export of
 * a long timeline genuinely takes that long and a lock that expired mid-render
 * would hand the job to a second worker while the first was still encoding —
 * two bills for one video.
 */

export interface QueuePolicy {
  /** Total tries, not retries: `attempts: 2` means one run and one retry. */
  readonly attempts: number;
  readonly backoffMs: number;
  /** Fraction of the computed delay to randomise, 0–1 (BullMQ `backoff.jitter`). */
  readonly backoffJitter: number;
  readonly lockDurationMs: number;
  readonly stalledIntervalMs: number;
  readonly maxStalledCount: number;
}

/** The `render` family defaults. */
export const RENDER_QUEUE_POLICY: QueuePolicy = Object.freeze({
  attempts: 2,
  backoffMs: 30_000,
  backoffJitter: 0.3,
  lockDurationMs: 300_000,
  stalledIntervalMs: 60_000,
  maxStalledCount: 1,
});

/** Per-queue overrides; only the fields that differ from the family. */
export const RENDER_QUEUE_OVERRIDES: Readonly<Record<string, Partial<QueuePolicy>>> = Object.freeze(
  {
    "render.video": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
  },
);

export function queuePolicyFor(queueName: string): QueuePolicy {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const override = RENDER_QUEUE_OVERRIDES[queueName];
  return override === undefined
    ? RENDER_QUEUE_POLICY
    : Object.freeze({ ...RENDER_QUEUE_POLICY, ...override });
}

/**
 * How often a worker on this queue must post progress.
 *
 * A third of the lock — the standard heartbeat safety factor, so two missed
 * beats still leave the lock alive. The progress callback *is* the heartbeat:
 * `JobsService.recordProgress` promotes a queued job to running precisely so one
 * call does both, which is why a long render posts its percentage even when it
 * has nothing new to say.
 */
export function heartbeatIntervalMs(queueName: string): number {
  return Math.floor(queuePolicyFor(queueName).lockDurationMs / 3);
}

/** BullMQ `Worker` options derived from the table. */
export function workerOptions(queueName: string): {
  lockDuration: number;
  stalledInterval: number;
  maxStalledCount: number;
} {
  const policy = queuePolicyFor(queueName);
  return {
    lockDuration: policy.lockDurationMs,
    stalledInterval: policy.stalledIntervalMs,
    maxStalledCount: policy.maxStalledCount,
  };
}
