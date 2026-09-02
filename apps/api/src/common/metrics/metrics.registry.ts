/**
 * A very small metric registry that can render itself as Prometheus text.
 *
 * **Why this exists rather than a library.** The OpenTelemetry metrics *API* is
 * already a dependency (`@opentelemetry/api`), but an API without a registered
 * `MeterProvider` is a no-op by design — instruments record into nothing — and the
 * SDK side of metrics (`@opentelemetry/sdk-metrics` plus an OTLP metric exporter
 * and a Prometheus exporter) is three more packages and a scrape server of its own.
 * `infra/observability/METRICS.md` is push-based over OTLP, so nothing in the
 * shipped deployment scrapes anything today; what the A08b brief asks for is a
 * `GET /internal/metrics` an operator and a Prometheus can both read.
 *
 * So: this registry holds the numbers, {@link MetricsService} mirrors every record
 * into the OTel API instruments as well, and the day a `MeterProvider` is
 * registered both paths carry the same data. Nothing here is a general metrics
 * library — no exemplars, no summaries, no registry federation — and it should be
 * deleted the moment the OTel metrics SDK is wired up.
 *
 * Cardinality is the one rule that matters (METRICS.md §Cardinality): every label
 * value here comes from a closed set — a queue name, a status, a reason — and
 * never from a workspace, project, job or user id.
 */

/** Label values for one time series. Insertion order does not matter. */
export type Labels = Readonly<Record<string, string>>;

export type MetricKind = "counter" | "gauge" | "histogram";

interface SeriesBase {
  readonly labels: Labels;
}

interface ScalarSeries extends SeriesBase {
  value: number;
}

interface HistogramSeries extends SeriesBase {
  /** One count per bucket in {@link MetricDefinition.buckets}, plus `+Inf` last. */
  readonly counts: number[];
  sum: number;
  count: number;
}

export interface MetricDefinition {
  /** Prometheus name, already in `snake_case` with its unit suffix and `_total`. */
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
  /** Upper bounds for a histogram, ascending. `+Inf` is implied and not listed. */
  readonly buckets?: readonly number[];
}

/** Escape a label value for the Prometheus text format. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

/** `{a="1",b="2"}`, or the empty string. Keys are sorted so the key is stable. */
function renderLabels(labels: Labels, extra?: Labels): string {
  const merged: Record<string, string> = { ...labels, ...(extra ?? {}) };
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((key) => `${key}="${escapeLabelValue(merged[key] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

/** Identity of a series within a metric. Sorted, so label order never matters. */
function seriesKey(labels: Labels): string {
  return renderLabels(labels);
}

/**
 * A counter, gauge or histogram identified by name, with one series per label set.
 *
 * Series are created on first use and never removed: a metric that disappears when
 * it returns to zero is worse than useless, because `rate()` on a series that
 * vanishes and reappears is indistinguishable from a counter reset.
 */
class Metric {
  private readonly scalars = new Map<string, ScalarSeries>();
  private readonly histograms = new Map<string, HistogramSeries>();

  constructor(readonly definition: MetricDefinition) {}

  add(labels: Labels, delta: number): void {
    const series = this.scalar(labels);
    series.value += delta;
  }

  set(labels: Labels, value: number): void {
    this.scalar(labels).value = value;
  }

  observe(labels: Labels, value: number): void {
    const buckets = this.definition.buckets ?? [];
    const key = seriesKey(labels);
    let series = this.histograms.get(key);
    if (series === undefined) {
      series = { labels, counts: new Array<number>(buckets.length + 1).fill(0), sum: 0, count: 0 };
      this.histograms.set(key, series);
    }
    series.sum += value;
    series.count += 1;
    // Cumulative buckets: Prometheus `le` is "less than or equal", so a value
    // lands in its own bucket and in every wider one.
    let index = buckets.findIndex((bound) => value <= bound);
    if (index < 0) index = buckets.length;
    for (let i = index; i < series.counts.length; i += 1) {
      series.counts[i] = (series.counts[i] ?? 0) + 1;
    }
  }

  /** The current value of one series, for tests and for the admin views. */
  value(labels: Labels = {}): number {
    return this.scalars.get(seriesKey(labels))?.value ?? 0;
  }

  /** `{ count, sum }` of one histogram series. */
  summary(labels: Labels = {}): { count: number; sum: number } {
    const series = this.histograms.get(seriesKey(labels));
    return { count: series?.count ?? 0, sum: series?.sum ?? 0 };
  }

  reset(): void {
    this.scalars.clear();
    this.histograms.clear();
  }

  render(): string[] {
    const { name, kind, help, buckets } = this.definition;
    const lines: string[] = [`# HELP ${name} ${help}`, `# TYPE ${name} ${kind}`];

    if (kind === "histogram") {
      for (const series of this.histograms.values()) {
        const bounds = buckets ?? [];
        bounds.forEach((bound, index) => {
          lines.push(
            `${name}_bucket${renderLabels(series.labels, { le: formatNumber(bound) })} ` +
              `${String(series.counts[index] ?? 0)}`,
          );
        });
        lines.push(
          `${name}_bucket${renderLabels(series.labels, { le: "+Inf" })} ${String(series.count)}`,
        );
        lines.push(`${name}_sum${renderLabels(series.labels)} ${formatNumber(series.sum)}`);
        lines.push(`${name}_count${renderLabels(series.labels)} ${String(series.count)}`);
      }
      return lines;
    }

    for (const series of this.scalars.values()) {
      lines.push(`${name}${renderLabels(series.labels)} ${formatNumber(series.value)}`);
    }
    return lines;
  }

  private scalar(labels: Labels): ScalarSeries {
    const key = seriesKey(labels);
    let series = this.scalars.get(key);
    if (series === undefined) {
      series = { labels, value: 0 };
      this.scalars.set(key, series);
    }
    return series;
  }
}

/** Prometheus wants `1`, not `1.0000000000000002`, and `+Inf` for infinity. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

/** The set of metrics one process exposes. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  define(definition: MetricDefinition): void {
    if (this.metrics.has(definition.name)) return;
    this.metrics.set(definition.name, new Metric(definition));
  }

  /** @throws when the metric was never defined — a typo must not be a silent zero. */
  private metric(name: string): Metric {
    const metric = this.metrics.get(name);
    if (metric === undefined) throw new Error(`Metric "${name}" is not defined.`);
    return metric;
  }

  increment(name: string, labels: Labels = {}, delta = 1): void {
    this.metric(name).add(labels, delta);
  }

  setGauge(name: string, labels: Labels, value: number): void {
    this.metric(name).set(labels, value);
  }

  observe(name: string, labels: Labels, value: number): void {
    this.metric(name).observe(labels, value);
  }

  value(name: string, labels: Labels = {}): number {
    return this.metric(name).value(labels);
  }

  summary(name: string, labels: Labels = {}): { count: number; sum: number } {
    return this.metric(name).summary(labels);
  }

  /** Drop every series. Tests only; a process never resets its own metrics. */
  reset(): void {
    for (const metric of this.metrics.values()) metric.reset();
  }

  /** The whole registry in the Prometheus text exposition format. */
  render(): string {
    const blocks: string[] = [];
    for (const metric of this.metrics.values()) {
      const lines = metric.render();
      // A metric with only its HELP and TYPE lines is noise; skip it until it has
      // recorded something.
      if (lines.length > 2) blocks.push(lines.join("\n"));
    }
    return `${blocks.join("\n")}\n`;
  }
}
