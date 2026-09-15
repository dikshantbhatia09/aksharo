/**
 * Admission-control and queue tuning for A08 (THREAT-MODEL T23: denial of wallet).
 *
 * Everything here is a plain constant rather than an environment variable on
 * purpose: CONTRACTS §1 is a frozen list of *product* configuration, and a cap the
 * pricing model depends on must move through a code review, not through a
 * deployment's env block. The one exception is {@link queuePrefix}, which is
 * infrastructure naming rather than policy.
 *
 * B02 replaces the credit numbers with the plan's real entitlement row; until then
 * these are the interim values from `04-pricing-and-monetization.md §Plans`.
 */

import type { PlanKey } from "@prisma/client";

/** Every plan in the ladder, weakest first. Mirrors the `PlanKey` enum of 06. */
export const PLAN_KEYS = ["free", "starter", "creator", "studio", "agency"] as const;

/**
 * BullMQ priority: **lower runs first**, and `0` means "unprioritised", which
 * BullMQ treats as *last*. So the ladder starts at 1 and never uses 0.
 */
export const PLAN_PRIORITY: Readonly<Record<PlanKey, number>> = Object.freeze({
  agency: 1,
  studio: 2,
  creator: 3,
  starter: 4,
  free: 5,
});

/**
 * How long a job may sit in `queued` before the sweeper fails it and releases its
 * hold. A paying workspace waits less, because its lane is the one we buy capacity
 * for; a free job that has waited half an hour is better failed than left to rot.
 */
export const PLAN_MAX_QUEUE_WAIT_MS: Readonly<Record<PlanKey, number>> = Object.freeze({
  agency: 5 * 60_000,
  studio: 10 * 60_000,
  creator: 15 * 60_000,
  starter: 20 * 60_000,
  free: 30 * 60_000,
});

/**
 * Enqueued-credit cap in tenths: the sum of the worst-case holds of every job a
 * workspace has in `queued` or `running`. Exceeding it is `jobs/enqueue_cap` (429),
 * which is the wall between "a script went wrong" and "the credit balance is gone".
 */
export const PLAN_ENQUEUED_CAP_TENTHS: Readonly<Record<PlanKey, number>> = Object.freeze({
  agency: 30_000,
  studio: 10_000,
  creator: 3_000,
  starter: 1_000,
  free: 300,
});

/**
 * Concurrency lane: how many jobs one workspace may have in flight
 * (`queued` + `running`) at once, regardless of their cost. Stops one workspace
 * from filling a queue with cheap jobs and starving everybody else.
 */
export const PLAN_CONCURRENCY_LANE: Readonly<Record<PlanKey, number>> = Object.freeze({
  agency: 32,
  studio: 16,
  creator: 8,
  starter: 4,
  free: 2,
});

/**
 * Free-tier daily allowance, in minutes of cloud media processing.
 *
 * One credit buys one minute of cloud transcription (`@montaj/config` §credits), so
 * the cap in tenths is `FREE_TIER_DAILY_MINUTES * 10`. Enforced by the no-op
 * `CreditsFacade`; B02 moves it onto the entitlement row.
 */
export const FREE_TIER_DAILY_MINUTES = 30;

/** Rolling window the free-tier allowance is measured over. */
export const FREE_TIER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How often the queue-timeout sweeper runs (brief §2). */
export const QUEUE_TIMEOUT_INTERVAL_MS = 30_000;

/** Rows the sweeper fails in one pass, so a backlog cannot hold a transaction open. */
export const QUEUE_TIMEOUT_BATCH = 200;

/** `job_events.data` carries this marker; the A08b retention sweep reads it (D47). */
export const JOB_EVENT_RETENTION_DAYS = 30;

/** When the job-event retention sweep runs. Off-peak, and after the nightly rollups. */
export const JOB_EVENT_RETENTION_CRON = "25 3 * * *";

/**
 * Rows the retention sweep deletes per statement.
 *
 * A single unbounded `DELETE` over a month of events would hold one transaction -
 * and the locks under it - for as long as it takes; the sweep loops on this batch
 * instead and stops as soon as a pass deletes fewer than a full batch.
 */
export const JOB_EVENT_RETENTION_BATCH = 5_000;

/** Ceiling on batches per run, so one pathological night cannot run until morning. */
export const JOB_EVENT_RETENTION_MAX_BATCHES = 200;

/** Default page size for `GET /jobs` and `GET /jobs/{id}/events`. */
export const JOBS_PAGE_SIZE = 25;

/** Hard ceiling on `limit`, so a caller cannot ask for the whole table. */
export const JOBS_MAX_PAGE_SIZE = 100;

/**
 * Dead letters one bulk replay or discard may touch.
 *
 * A ceiling, not a page size: `docs/runbooks/dlq-replay.md` §4 tells an operator
 * to replay in small batches and watch the first one land, because a full-throttle
 * replay competes with live user traffic for the same workers. A cap makes that
 * advice hard to ignore by accident.
 */
export const DLQ_MAX_BULK = 100;

/**
 * How often the per-queue backlog gauge is re-sampled from Redis.
 *
 * 15 s, matching KEDA's default polling interval: the autoscaler scales on this
 * series (`infra/k8s/montaj/templates/scaledobject.yaml`), so sampling slower
 * than it polls would make every scaling decision act on stale depth.
 */
export const QUEUE_DEPTH_INTERVAL_MS = 15_000;

/** How often the dead-letter depth gauge is re-sampled from Postgres. */
export const DLQ_DEPTH_INTERVAL_MS = 60_000;

/**
 * BullMQ retry and stall policy per queue. A08 set the shape and the attempt
 * counts; A08b adds the jitter, the lock durations and the stall detection.
 *
 * Four numbers, and each is load-bearing in a different way:
 *
 * - **`attempts`** is the retry budget. When it is spent the job is dead-lettered
 *   (`DlqService`) rather than retried forever, because a job that has failed
 *   every attempt is a decision for a human (`docs/runbooks/dlq-replay.md`).
 * - **`backoffMs` + `backoffJitter`** space the retries out. Jitter is not a
 *   nicety: a provider outage fails every in-flight job at almost the same
 *   instant, and an un-jittered exponential backoff retries them all at almost the
 *   same instant too - a thundering herd onto a provider that is still down.
 *   `jitter` is BullMQ own fraction (0-1) of the computed delay to randomise.
 * - **`lockDurationMs`** is how long a worker may hold a job without renewing the
 *   lock. Too short and a long job is declared stalled and handed to a second
 *   worker *while the first is still running it*, which is a double charge; too
 *   long and a worker that really did die takes that long to be noticed. A
 *   transcription of a two-hour recording is the hard case, hence ten minutes on
 *   `ai.transcribe`.
 * - **`stalledIntervalMs`** is how often the stall check runs, and
 *   **`maxStalledCount`** how many times a job may be recovered before it is
 *   failed outright. One, everywhere except `notify`: a job that stalls twice is
 *   not unlucky, it is killing its worker.
 *
 * `attempts` and `backoff` travel to the worker inside the BullMQ job options, so
 * a worker needs no configuration to honour them. `lockDurationMs`,
 * `stalledIntervalMs` and `maxStalledCount` are `Worker` constructor options and
 * therefore have to be READ from here by each worker package - which is exactly
 * the "worker-side changes beyond reading policies" the A08b brief puts out of
 * scope. Until they do, this table is the specification they are measured against
 * and {@link heartbeatIntervalMs} is the number a worker needs most.
 */
export interface QueuePolicy {
  /** Total tries, not retries: `attempts: 3` means one run and two retries. */
  readonly attempts: number;
  /** Base delay of the exponential backoff. */
  readonly backoffMs: number;
  /** Fraction of the computed delay to randomise, 0-1 (BullMQ `backoff.jitter`). */
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

/**
 * Per-family defaults, keyed on the part of the queue name before the dot.
 *
 * The attempt counts are the A08b brief numbers: media 3, ai 2, render 2,
 * notify 5. `notify` retries most and backs off least because a notification is
 * cheap, idempotent and worthless late; `render` retries least and backs off most
 * because a re-render costs GPU minutes and a failing one usually fails again.
 *
 * `publish` (REP-005) is the odd one: **one attempt, never retried by the queue**.
 * Every other queue's work is idempotent, so a retry is free; a publish is an
 * external side effect, and a blind retry after a lost response is how a product
 * posts the same video twice. The next attempt is created deliberately, by
 * `publish.reconcile` once it has established what the provider actually did, or
 * by the user pressing Retry — never by BullMQ. The dispatcher also re-reads the
 * target's stored provider reference before submitting, so even a stalled-job
 * recovery cannot submit a second time (master plan §4.3).
 */
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

/**
 * Queues whose work is long enough that the family lock would expire mid-job.
 *
 * Only the fields that differ are listed. Ten minutes on the ASR queues is the
 * brief number and comes from the worst realistic case: a two-hour recording on a
 * cold GPU. `render.video` gets the same, for the same reason.
 *
 * The two `media.*` queues get it too (A07). The family default of two minutes
 * was sized for "run ffprobe on a short clip"; the real worst case is a 4K
 * sixty-minute upload, where the loudness pass alone reads the whole audio track
 * and the proxy transcode reads and re-encodes every frame. A two-minute lock
 * there means the job is declared stalled and handed to a second worker while the
 * first is still encoding — two ffmpeg processes writing the same derived keys.
 */
export const QUEUE_POLICY_OVERRIDES: Readonly<Record<string, Partial<QueuePolicy>>> = Object.freeze(
  {
    "media.probe": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "media.proxy": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "media.acquire": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "media.clip": { lockDurationMs: 300_000, stalledIntervalMs: 60_000 },
    "ai.highlights": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.transcribe": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.diarise": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
    "ai.align": { lockDurationMs: 300_000, stalledIntervalMs: 60_000 },
    "render.video": { lockDurationMs: 600_000, stalledIntervalMs: 60_000 },
  },
);

/** The policy for a queue: its family defaults, with any per-queue override. */
export function queuePolicyFor(queueName: string): QueuePolicy {
  const family = queueName.split(".")[0] ?? queueName;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const base = QUEUE_POLICY_BY_FAMILY[family] ?? DEFAULT_QUEUE_POLICY;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  const override = QUEUE_POLICY_OVERRIDES[queueName];
  return override === undefined ? base : Object.freeze({ ...base, ...override });
}

/**
 * How often a worker on this queue must call `POST /internal/jobs/{id}/progress`.
 *
 * A third of the lock, which is the standard heartbeat safety factor: two
 * consecutive missed beats still leave the lock alive. The progress callback is
 * the heartbeat - `JobsService.recordProgress` promotes a `queued` job to
 * `running` precisely so that one call does both jobs - and a worker that renews
 * its BullMQ lock on the same tick can never be declared stalled while it is
 * genuinely working.
 */
export function heartbeatIntervalMs(queueName: string): number {
  return Math.floor(queuePolicyFor(queueName).lockDurationMs / 3);
}

/**
 * Redis key prefix for every BullMQ structure.
 *
 * `bull` is BullMQ's own default and what `apps/worker-media`, `apps/render` and
 * `apps/worker-ai` use, so the default must stay `bull` or producers and consumers
 * would silently talk past each other. `MONTAJ_QUEUE_PREFIX` exists so a developer
 * (or a parallel test run) can isolate a Redis instance shared with other work.
 *
 * Read from `process.env` rather than the validated `Env`, for the same reason the
 * OpenTelemetry variables are: CONTRACTS §1 is the frozen list of *product*
 * configuration and this is deployment naming.
 */
export function queuePrefix(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source["MONTAJ_QUEUE_PREFIX"]?.trim();
  return raw === undefined || raw === "" ? "bull" : raw;
}

/** Plan-derived admission limits for one workspace. */
export interface PlanLimits {
  readonly plan: PlanKey;
  readonly priority: number;
  readonly maxQueueWaitMs: number;
  readonly enqueuedCapTenths: number;
  readonly concurrencyLane: number;
}

export function planLimits(plan: PlanKey): PlanLimits {
  return {
    plan,
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    priority: PLAN_PRIORITY[plan],
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    maxQueueWaitMs: PLAN_MAX_QUEUE_WAIT_MS[plan],
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    enqueuedCapTenths: PLAN_ENQUEUED_CAP_TENTHS[plan],
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    concurrencyLane: PLAN_CONCURRENCY_LANE[plan],
  };
}
