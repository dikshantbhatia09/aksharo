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

/** `job_events.data` carries this marker; the daily purge (B16) reads it. */
export const JOB_EVENT_RETENTION_DAYS = 30;

/** Default page size for `GET /jobs` and `GET /jobs/{id}/events`. */
export const JOBS_PAGE_SIZE = 25;

/** Hard ceiling on `limit`, so a caller cannot ask for the whole table. */
export const JOBS_MAX_PAGE_SIZE = 100;

/**
 * BullMQ retry policy per queue family. A08 sets the shape and the defaults;
 * A08b tunes the numbers and adds the lock durations for long ASR jobs.
 */
export interface RetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({ attempts: 2, backoffMs: 10_000 });

export const RETRY_POLICY_BY_PREFIX: Readonly<Record<string, RetryPolicy>> = Object.freeze({
  media: { attempts: 3, backoffMs: 5_000 },
  ai: { attempts: 2, backoffMs: 15_000 },
  render: { attempts: 2, backoffMs: 30_000 },
  notify: { attempts: 5, backoffMs: 2_000 },
});

/** The retry policy for a queue, chosen by its `family.name` prefix. */
export function retryPolicyFor(queueName: string): RetryPolicy {
  const family = queueName.split(".")[0] ?? queueName;
  return RETRY_POLICY_BY_PREFIX[family] ?? DEFAULT_RETRY_POLICY;
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
    priority: PLAN_PRIORITY[plan],
    maxQueueWaitMs: PLAN_MAX_QUEUE_WAIT_MS[plan],
    enqueuedCapTenths: PLAN_ENQUEUED_CAP_TENTHS[plan],
    concurrencyLane: PLAN_CONCURRENCY_LANE[plan],
  };
}
