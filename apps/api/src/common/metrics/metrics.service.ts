import { Injectable } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";

import { MetricsRegistry } from "./metrics.registry.js";

import type { Labels } from "./metrics.registry.js";
import type { Counter, Histogram, Meter, UpDownCounter } from "@opentelemetry/api";

/**
 * The metric names this process exposes, in their **Prometheus** form.
 *
 * `infra/observability/METRICS.md` is the contract and says so in as many words:
 * "A metric name here is as frozen as an API route... a missing series looks
 * exactly like a healthy zero." So the canonical names below are METRICS.md's,
 * spelled the way its own §10 says the collector rewrites them (dots to
 * underscores, unit suffix, `_total` on counters) — which is also how the shipped
 * dashboards and the `MontajDlqNonEmpty` / `MontajDlqGrowing` alert rules query
 * them.
 *
 * The A08b brief §4 names three metrics differently (`montaj_jobs_failed_total`,
 * `montaj_dlq_depth`, `montaj_job_queue_wait_ms`). The brief predates X05, and
 * emitting only its names would leave two shipped alert rules and a dashboard
 * panel querying a series that never appears. Both sets are therefore emitted:
 * the METRICS.md names are canonical, the brief's are **aliases** recorded from
 * the same call site. Retiring one set is an ADR (METRICS.md §Conventions), not a
 * decision for this work package — it is raised in the A08b report.
 */
export const METRIC = {
  /** METRICS.md §3. `status` ∈ succeeded | failed | cancelled | expired. */
  jobCompleted: "montaj_job_completed_total",
  /** METRICS.md §2. Pending dead letters, per queue. */
  dlqDepth: "montaj_queue_dlq_depth",
  /** METRICS.md §2. Enqueue to first pickup, in seconds. */
  queueWait: "montaj_queue_wait_duration_seconds",
  /** METRICS.md §3. Attempts before a terminal state. */
  jobAttempts: "montaj_job_attempts",
  /** Not in METRICS.md: what an operator did about a dead letter. A08b. */
  dlqResolved: "montaj_dlq_resolved_total",

  // --- A08b brief §4 aliases. Same data, the brief's names. -----------------
  /** Alias of `montaj_job_completed_total{status="failed"}`. */
  aliasJobsFailed: "montaj_jobs_failed_total",
  /** Alias of `montaj_queue_dlq_depth`. */
  aliasDlqDepth: "montaj_dlq_depth",
  /** Alias of `montaj_queue_wait_duration_seconds`, in milliseconds. */
  aliasQueueWaitMs: "montaj_job_queue_wait_ms",
} as const;

/** METRICS.md §2: 1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600 seconds. */
const QUEUE_WAIT_BUCKETS_SECONDS = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600] as const;

/** The same ladder in milliseconds, for the brief-named alias. */
const QUEUE_WAIT_BUCKETS_MS = QUEUE_WAIT_BUCKETS_SECONDS.map((seconds) => seconds * 1000);

/** Attempts before a terminal state; the retry budgets are 2-5 (`jobs.config.ts`). */
const ATTEMPT_BUCKETS = [1, 2, 3, 4, 5, 8] as const;

/**
 * Application metrics: the job, queue and dead-letter counters of
 * `infra/observability/METRICS.md`, plus the Prometheus rendering behind
 * `GET /internal/metrics`.
 *
 * Every record goes to two places. The in-process {@link MetricsRegistry} is what
 * the endpoint renders and what tests assert on; the OpenTelemetry instruments are
 * what a collector will pick up the moment a `MeterProvider` is registered. With
 * no provider — which is the state today, `startTelemetry()` configures traces
 * only — the OTel half is a no-op that costs one virtual call, exactly like
 * tracing with no OTLP endpoint.
 *
 * Recording never throws. A metric that cannot be written must not fail the job
 * transition it was describing.
 */
@Injectable()
export class MetricsService {
  readonly registry = new MetricsRegistry();
  private readonly meter: Meter = metrics.getMeter("montaj-api");
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, UpDownCounter>();
  private readonly histograms = new Map<string, Histogram>();
  /** Last value written to each gauge series, so the OTel up/down counter can delta. */
  private readonly gaugeState = new Map<string, number>();

  constructor() {
    this.registry.define({
      name: METRIC.jobCompleted,
      kind: "counter",
      help: "Jobs that reached a terminal state, by queue and status (METRICS.md 3).",
    });
    this.registry.define({
      name: METRIC.dlqDepth,
      kind: "gauge",
      help: "Pending dead-lettered jobs, by queue (METRICS.md 2).",
    });
    this.registry.define({
      name: METRIC.queueWait,
      kind: "histogram",
      help: "Seconds from enqueue to first pickup, by queue (METRICS.md 2).",
      buckets: QUEUE_WAIT_BUCKETS_SECONDS,
    });
    this.registry.define({
      name: METRIC.jobAttempts,
      kind: "histogram",
      help: "Attempts a job made before reaching a terminal state (METRICS.md 3).",
      buckets: ATTEMPT_BUCKETS,
    });
    this.registry.define({
      name: METRIC.dlqResolved,
      kind: "counter",
      help: "Dead letters an admin resolved, by queue and outcome (replayed, discarded).",
    });
    this.registry.define({
      name: METRIC.aliasJobsFailed,
      kind: "counter",
      help: "Alias of montaj_job_completed_total{status=failed} under the A08b brief name.",
    });
    this.registry.define({
      name: METRIC.aliasDlqDepth,
      kind: "gauge",
      help: "Alias of montaj_queue_dlq_depth under the A08b brief name.",
    });
    this.registry.define({
      name: METRIC.aliasQueueWaitMs,
      kind: "histogram",
      help: "Alias of montaj_queue_wait_duration_seconds in milliseconds (A08b brief name).",
      buckets: QUEUE_WAIT_BUCKETS_MS,
    });
  }

  // -------------------------------------------------------------------------
  // What the jobs module records
  // -------------------------------------------------------------------------

  /** A job reached a terminal state. `attempt` is the 1-based ordinal. */
  jobCompleted(input: {
    readonly queue: string;
    readonly status: "succeeded" | "failed" | "cancelled" | "expired";
    readonly attempt?: number;
  }): void {
    const labels: Labels = { queue: input.queue, status: input.status };
    this.count(METRIC.jobCompleted, labels);
    if (input.status === "failed") {
      this.count(METRIC.aliasJobsFailed, { queue: input.queue });
    }
    if (input.attempt !== undefined) {
      this.record(METRIC.jobAttempts, { queue: input.queue }, input.attempt);
    }
  }

  /** How long a job waited in `queued` before a worker picked it up. */
  queueWait(queue: string, waitedMs: number): void {
    const clamped = Math.max(0, waitedMs);
    this.record(METRIC.queueWait, { queue }, clamped / 1000);
    this.record(METRIC.aliasQueueWaitMs, { queue }, clamped);
  }

  /** Pending dead letters on one queue. Absolute, not a delta. */
  dlqDepth(queue: string, depth: number): void {
    this.gauge(METRIC.dlqDepth, { queue }, depth);
    this.gauge(METRIC.aliasDlqDepth, { queue }, depth);
  }

  /** An admin replayed or discarded a dead letter. */
  dlqResolved(queue: string, outcome: "replayed" | "discarded"): void {
    this.count(METRIC.dlqResolved, { queue, outcome });
  }

  /** The whole registry as Prometheus text. */
  render(): string {
    return this.registry.render();
  }

  // -------------------------------------------------------------------------
  // Registry + OTel, side by side
  // -------------------------------------------------------------------------

  private count(name: string, labels: Labels, delta = 1): void {
    try {
      this.registry.increment(name, labels, delta);
      this.otelCounter(name).add(delta, labels);
    } catch {
      /* a metric must never fail the transition it describes */
    }
  }

  private record(name: string, labels: Labels, value: number): void {
    try {
      this.registry.observe(name, labels, value);
      this.otelHistogram(name).record(value, labels);
    } catch {
      /* as above */
    }
  }

  private gauge(name: string, labels: Labels, value: number): void {
    try {
      this.registry.setGauge(name, labels, value);
      // The OTel API has no synchronous gauge before an observable callback, so
      // the up/down counter is driven by the delta against the last value.
      const key = `${name}${JSON.stringify(labels)}`;
      const previous = this.gaugeState.get(key) ?? 0;
      this.gaugeState.set(key, value);
      this.otelGauge(name).add(value - previous, labels);
    } catch {
      /* as above */
    }
  }

  private otelCounter(name: string): Counter {
    let instrument = this.counters.get(name);
    if (instrument === undefined) {
      instrument = this.meter.createCounter(name);
      this.counters.set(name, instrument);
    }
    return instrument;
  }

  private otelGauge(name: string): UpDownCounter {
    let instrument = this.gauges.get(name);
    if (instrument === undefined) {
      instrument = this.meter.createUpDownCounter(name);
      this.gauges.set(name, instrument);
    }
    return instrument;
  }

  private otelHistogram(name: string): Histogram {
    let instrument = this.histograms.get(name);
    if (instrument === undefined) {
      instrument = this.meter.createHistogram(name);
      this.histograms.set(name, instrument);
    }
    return instrument;
  }
}
