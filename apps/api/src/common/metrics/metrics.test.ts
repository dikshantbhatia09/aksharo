import { describe, expect, it } from "vitest";

import { metricsToken } from "./metrics.controller.js";
import { MetricsRegistry } from "./metrics.registry.js";
import { METRIC, MetricsService } from "./metrics.service.js";

describe("MetricsRegistry", () => {
  it("renders a counter in the Prometheus text format, labels sorted", () => {
    const registry = new MetricsRegistry();
    registry.define({ name: "montaj_thing_total", kind: "counter", help: "Things." });
    registry.increment("montaj_thing_total", { queue: "notify", status: "failed" });
    registry.increment("montaj_thing_total", { status: "failed", queue: "notify" }, 2);

    const text = registry.render();
    expect(text).toContain("# HELP montaj_thing_total Things.");
    expect(text).toContain("# TYPE montaj_thing_total counter");
    // One series, not two: label ORDER must not create a second time series.
    expect(text).toContain('montaj_thing_total{queue="notify",status="failed"} 3');
    expect(registry.value("montaj_thing_total", { queue: "notify", status: "failed" })).toBe(3);
  });

  it("keeps a gauge at zero rather than dropping the series", () => {
    const registry = new MetricsRegistry();
    registry.define({ name: "montaj_depth", kind: "gauge", help: "Depth." });
    registry.setGauge("montaj_depth", { queue: "ai.llm" }, 4);
    registry.setGauge("montaj_depth", { queue: "ai.llm" }, 0);

    // A series that vanishes at zero is indistinguishable from one nobody scraped.
    expect(registry.render()).toContain('montaj_depth{queue="ai.llm"} 0');
  });

  it("makes histogram buckets cumulative and emits the +Inf bucket", () => {
    const registry = new MetricsRegistry();
    registry.define({
      name: "montaj_wait_seconds",
      kind: "histogram",
      help: "Wait.",
      buckets: [1, 5, 10],
    });
    for (const value of [0.5, 3, 30]) registry.observe("montaj_wait_seconds", {}, value);

    const text = registry.render();
    expect(text).toContain('montaj_wait_seconds_bucket{le="1"} 1');
    expect(text).toContain('montaj_wait_seconds_bucket{le="5"} 2');
    expect(text).toContain('montaj_wait_seconds_bucket{le="10"} 2');
    expect(text).toContain('montaj_wait_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain("montaj_wait_seconds_count 3");
    expect(registry.summary("montaj_wait_seconds")).toEqual({ count: 3, sum: 33.5 });
  });

  it("escapes label values so a message can never break the exposition format", () => {
    const registry = new MetricsRegistry();
    registry.define({ name: "montaj_x_total", kind: "counter", help: "X." });
    registry.increment("montaj_x_total", { reason: 'a"b\\c' });
    expect(registry.render()).toContain('montaj_x_total{reason="a\\"b\\\\c"} 1');
  });

  it("throws on an undefined metric, so a typo is not a silent zero", () => {
    const registry = new MetricsRegistry();
    expect(() => registry.increment("montaj_typo_total")).toThrow(/not defined/);
  });

  it("omits a metric that has recorded nothing", () => {
    const registry = new MetricsRegistry();
    registry.define({ name: "montaj_quiet_total", kind: "counter", help: "Quiet." });
    expect(registry.render()).not.toContain("montaj_quiet_total");
  });
});

describe("MetricsService", () => {
  it("emits the METRICS.md names the shipped dashboards and alerts query", () => {
    const metrics = new MetricsService();
    metrics.jobCompleted({ queue: "ai.transcribe", status: "failed", attempt: 2 });
    metrics.dlqDepth("ai.transcribe", 7);
    metrics.queueWait("ai.transcribe", 45_000);

    const text = metrics.render();
    // infra/observability/alerts/montaj-alerts.yaml and the service-health
    // dashboard query exactly these three.
    expect(text).toContain("montaj_job_completed_total");
    expect(text).toContain("montaj_queue_dlq_depth");
    expect(text).toContain("montaj_queue_wait_duration_seconds");
  });

  it("also emits the A08b brief's three names, as aliases of the same data", () => {
    const metrics = new MetricsService();
    metrics.jobCompleted({ queue: "notify", status: "failed" });
    metrics.dlqDepth("notify", 3);
    metrics.queueWait("notify", 2_000);

    expect(metrics.registry.value(METRIC.aliasJobsFailed, { queue: "notify" })).toBe(1);
    expect(metrics.registry.value(METRIC.aliasDlqDepth, { queue: "notify" })).toBe(3);
    expect(metrics.registry.summary(METRIC.aliasQueueWaitMs, { queue: "notify" })).toEqual({
      count: 1,
      sum: 2_000,
    });
    // and the canonical histogram is the same observation in SECONDS
    expect(metrics.registry.summary(METRIC.queueWait, { queue: "notify" })).toEqual({
      count: 1,
      sum: 2,
    });
  });

  it("counts a failure only under the failed status", () => {
    const metrics = new MetricsService();
    metrics.jobCompleted({ queue: "notify", status: "succeeded" });
    expect(metrics.registry.value(METRIC.aliasJobsFailed, { queue: "notify" })).toBe(0);
  });

  it("never lets a negative wait reach the histogram", () => {
    const metrics = new MetricsService();
    metrics.queueWait("notify", -5_000);
    expect(metrics.registry.summary(METRIC.queueWait, { queue: "notify" })).toEqual({
      count: 1,
      sum: 0,
    });
  });
});

describe("metricsToken", () => {
  it("is undefined unless set, which leaves the endpoint open in-cluster", () => {
    expect(metricsToken({})).toBeUndefined();
    expect(metricsToken({ MONTAJ_METRICS_TOKEN: "" })).toBeUndefined();
    expect(metricsToken({ MONTAJ_METRICS_TOKEN: "   " })).toBeUndefined();
    expect(metricsToken({ MONTAJ_METRICS_TOKEN: " secret " })).toBe("secret");
  });
});
