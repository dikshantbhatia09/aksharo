# infra/observability

The metric contract, the dashboards that read it and the alerts that page on it.

| Path                                    | What it is                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| [`METRICS.md`](METRICS.md)              | **The contract.** Every OTel metric name, unit and label, plus the cardinality rules. A name here is as frozen as an API route.       |
| `dashboards/montaj-service-health.json` | API latency, 5xx, job success, queue depth per queue, queue wait, DLQ depth, provider errors, rejected callbacks.                     |
| `dashboards/montaj-cost-and-gpu.json`   | COGS per credit, COGS by component, credit reserve accuracy, GPU utilisation and duty cycle, cold starts, storage by retention class. |
| `alerts/montaj-alerts.yaml`             | A `PrometheusRule` with 4 recording rules and 24 alerts across six groups.                                                            |
| `scripts/extract-rules.py`              | Unwraps the `PrometheusRule` so `promtool check rules` can validate it.                                                               |

## Install

```bash
kubectl -n observability apply -f infra/observability/alerts/montaj-alerts.yaml
# Import both dashboards from dashboards/ into Grafana (or point a sidecar at them).
```

The `PrometheusRule` carries `release: kube-prometheus-stack`, which is how that
chart's operator selects rules. Change the label if your Prometheus selects
differently, or the rules will be applied and silently ignored — the worst
failure mode available, because everything looks installed.

## Why a metric contract exists at all

A dashboard panel and an alert rule both fail **silently** when a metric is
renamed: a missing series renders as a healthy zero. There is no error, no
warning, and no way to tell "nothing is wrong" from "nothing is being measured".

So the names are a contract between X05 and the work packages that emit them,
and renaming one is an ADR rather than a refactor.

The cardinality rules in `METRICS.md` are equally load-bearing in the other
direction: `workspace_id` as a metric label would multiply every series by the
number of customers and take the metric store down. Per-workspace cost lives in
Postgres — the daily COGS rollup in `05 §11` — not here.

## The numbers the alerts encode

Every threshold traces to a decision, not to taste:

| Threshold                              | Source                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| API p95 < 300 ms                       | `05 §10` SLO                                                      |
| Job success ≥ 99.5 %                   | `05 §10` SLO                                                      |
| COGS per credit ≤ 58 paise             | 50 % margin against ≈ ₹1.16 net revenue per credit (`05 §12`)     |
| COGS per credit > 232 paise pages      | The admin throttle at 2× revenue (`05 §11`)                       |
| GPU warm floor ≥ 1 per region          | Decision D15                                                      |
| GPU duty cycle > 60 % is informational | The serverless-versus-reserved crossover (`infra/gpu/COST.md §5`) |
| Raw-bucket egress is a warning         | Decision D35: client-facing objects come from R2                  |

## Validation

```bash
python3 infra/observability/scripts/extract-rules.py \
  infra/observability/alerts/montaj-alerts.yaml > /tmp/rules.yaml
promtool check rules /tmp/rules.yaml

kubeconform -strict -kubernetes-version 1.33.0 -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  infra/observability/alerts/
```

CI runs both, plus a JSON and duplicate-uid check over the dashboards.

## What is not here yet

- **Recording rules for the per-workspace COGS rollup.** That is a Postgres
  query (`05 §11`), not a Prometheus rule, and it belongs to the billing work
  packages.
- **SLO burn-rate alerts.** The current rules alert on the SLI crossing its
  threshold, which is simple and slightly noisy. Multi-window burn-rate alerting
  is the better shape once there is enough traffic for the error budget to mean
  something.
- **Every metric in `METRICS.md` is emitted.** The contract is defined here; the
  emitting code lands with the work packages that own each subsystem. Until then
  some panels will be empty — which is exactly the failure mode the contract
  exists to make visible.
