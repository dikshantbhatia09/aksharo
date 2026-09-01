# METRICS.md — the OpenTelemetry metric contract

Defined by **X05**, consumed by the dashboards in `dashboards/`, the alert rules
in `alerts/` and the admin cost views. Emitting code lives in the application
work packages; this file is the name and label contract between them.

**A metric name here is as frozen as an API route.** A dashboard panel and an
alert rule both break silently when a name or a label changes — silently,
because a missing series looks exactly like a healthy zero. Renaming one is an
ADR, not a refactor.

## Conventions

- Names follow OpenTelemetry semantic conventions where one exists
  (`http.server.request.duration`), and are prefixed `montaj.` where none does.
- Units follow the OTel unit convention: seconds (`s`), bytes (`By`), `{job}`,
  `1`.
- Durations are **histograms in seconds**, never milliseconds and never gauges
  of an average. A gauge of an average cannot produce a p95.
- Money is **integer minor units** (paise), matching CONTRACTS section 0.
  Credits are **integer tenths** (`*_tenths`), likewise.
- Every metric carries `deployment.environment` and `service.name` from the OTel
  resource. They are not repeated in the tables below.

### Cardinality rules

These are load-bearing: a label with unbounded values turns a metric store into
an outage.

- **Never** a label: `workspace_id`, `project_id`, `job_id`, `user_id`,
  `media_id`. Per-workspace cost lives in Postgres (the daily COGS rollup in
  `05 §11`), not in the metric store.
- **Allowed**: `queue` (14 values, CONTRACTS section 3), `job_kind`,
  `provider`, `model`, `status`, `route`, `method`, `plan`, `region`.
- `route` is the **templated** path (`/projects/{id}`), never the resolved one.

## 1. HTTP — API latency and errors

| Metric                           | Type            | Unit        | Labels                                                           | Meaning                                                                                                                           |
| -------------------------------- | --------------- | ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `http.server.request.duration`   | histogram       | `s`         | `http.route`, `http.request.method`, `http.response.status_code` | Server-side request duration. The p95 in the SLO (`05 §10`: < 300 ms) is computed from this.                                      |
| `http.server.active_requests`    | up/down counter | `{request}` | `http.route`, `http.request.method`                              | In-flight requests.                                                                                                               |
| `montaj.http.admission.rejected` | counter         | `{request}` | `reason`, `plan`                                                 | Requests refused by admission control (THREAT-MODEL T23). `reason` ∈ `queue_wait`, `enqueued_credits`, `rate_limit`, `daily_cap`. |

Histogram buckets for `http.server.request.duration`, in seconds:
`0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.3, 0.5, 1, 2.5, 5, 10`.
The explicit `0.3` bucket exists so the 300 ms SLO is an exact boundary rather
than an interpolation between 0.25 and 0.5.

## 2. Queues — depth, wait and throughput

Queue names are exactly the fourteen in CONTRACTS section 3: `media.probe`,
`media.proxy`, `ai.vad`, `ai.transcribe`, `ai.align`, `ai.diarise`,
`ai.translate`, `ai.transliterate`, `ai.clean`, `ai.pass`, `ai.llm`,
`render.video`, `render.subtitle`, `notify`.

| Metric                       | Type      | Unit    | Labels              | Meaning                                                                                                                                                  |
| ---------------------------- | --------- | ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `montaj.queue.depth`         | gauge     | `{job}` | `queue`, `state`    | Jobs in the queue. `state` ∈ `waiting`, `active`, `delayed`, `failed`. Sampled by the scheduler every 15 s from BullMQ.                                  |
| `montaj.queue.wait.duration` | histogram | `s`     | `queue`, `priority` | Enqueue to first pickup. This is what the user experiences as "nothing is happening yet".                                                                |
| `montaj.queue.dlq.depth`     | gauge     | `{job}` | `queue`             | Dead-letter depth. Anything above zero is a human decision (`docs/runbooks/dlq-replay.md`).                                                              |
| `montaj.queue.oldest.age`    | gauge     | `s`     | `queue`             | Age of the oldest waiting job. Catches a stalled queue that depth alone would not: depth 3 for forty minutes is worse than depth 300 for twenty seconds. |

Buckets for `montaj.queue.wait.duration`, in seconds:
`1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600`.

## 3. Jobs — success, duration, attempts

| Metric                         | Type      | Unit        | Labels                                   | Meaning                                                                                                                                                                |
| ------------------------------ | --------- | ----------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `montaj.job.completed`         | counter   | `{job}`     | `queue`, `job_kind`, `status`, `attempt` | `status` ∈ `succeeded`, `failed`, `cancelled`, `expired`. The job success rate in the SLO (`05 §10`: ≥ 99.5 %) is derived from this.                                   |
| `montaj.job.duration`          | histogram | `s`         | `queue`, `job_kind`, `status`            | Pickup to completion.                                                                                                                                                  |
| `montaj.job.attempts`          | histogram | `1`         | `queue`, `job_kind`                      | Attempts before a terminal state. A rising p50 means retries are hiding a systemic failure.                                                                            |
| `montaj.job.media.seconds`     | counter   | `s`         | `queue`, `job_kind`                      | Media seconds processed. The denominator of every per-media-minute cost figure.                                                                                        |
| `montaj.job.output.seconds`    | counter   | `s`         | `job_kind`                               | Output seconds produced (render).                                                                                                                                      |
| `montaj.job.callback.rejected` | counter   | `{request}` | `reason`                                 | Completion callbacks refused. `reason` ∈ `bad_signature`, `skew`, `unknown_job`, `attempt_mismatch` (THREAT-MODEL T8). A spike is either a clock problem or an attack. |

## 4. Providers — ASR, LLM, GPU

| Metric                             | Type      | Unit        | Labels                                     | Meaning                                                                                                                        |
| ---------------------------------- | --------- | ----------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `montaj.provider.request.duration` | histogram | `s`         | `provider`, `model`, `operation`, `status` | Round trip to a provider. `provider` ∈ `elevenlabs`, `sarvam`, `assemblyai`, `anthropic`, `openai`, `runpod`, `modal`, `self`. |
| `montaj.provider.errors`           | counter   | `{request}` | `provider`, `model`, `error_kind`          | `error_kind` ∈ `timeout`, `rate_limited`, `auth`, `server`, `invalid_response`.                                                |
| `montaj.provider.tokens`           | counter   | `{token}`   | `provider`, `model`, `direction`           | LLM tokens. `direction` ∈ `input`, `output`.                                                                                   |
| `montaj.provider.cost.minor`       | counter   | `1`         | `provider`, `model`, `currency`            | Provider spend in minor units, as reported in the `usage` block of the completion callback (CONTRACTS section 3).              |

## 5. GPU

Scraped from DCGM on an in-cluster GPU node group, or from the serverless
provider's metrics API when `GPU_PROVIDER` is `runpod` or `modal`. Both paths
publish the same names so a dashboard survives the D15 migration to reserved GPU.

| Metric                      | Type    | Unit | Labels                            | Meaning                                                                                                                 |
| --------------------------- | ------- | ---- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `montaj.gpu.utilization`    | gauge   | `1`  | `region`, `gpu_class`, `instance` | Fraction 0–1 of SM utilisation. The duty-cycle number that decides serverless versus reserved (`infra/gpu/COST.md §5`). |
| `montaj.gpu.memory.used`    | gauge   | `By` | `region`, `gpu_class`, `instance` | VRAM in use.                                                                                                            |
| `montaj.gpu.workers.active` | gauge   | `1`  | `region`, `endpoint`              | Workers currently running a request.                                                                                    |
| `montaj.gpu.workers.idle`   | gauge   | `1`  | `region`, `endpoint`              | Warm but idle. Should not sit above the D15 warm floor of 1.                                                            |
| `montaj.gpu.cold_starts`    | counter | `1`  | `region`, `endpoint`              | Cold starts. A rising rate means the warm floor is set too low for the traffic shape.                                   |
| `montaj.gpu.seconds.billed` | counter | `s`  | `region`, `gpu_class`, `endpoint` | Billed GPU seconds. Numerator of the GPU cost per media minute.                                                         |

## 6. Cost and credits — COGS per credit

The panel `05 §11` calls for. Credits are integer tenths; money is integer minor
units (paise).

| Metric                           | Type    | Unit | Labels                       | Meaning                                                                                                   |
| -------------------------------- | ------- | ---- | ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `montaj.credits.reserved_tenths` | counter | `1`  | `job_kind`, `plan`           | Worst-case credits held by `CreditsFacade.reserve` (CONTRACTS section 4).                                 |
| `montaj.credits.settled_tenths`  | counter | `1`  | `job_kind`, `plan`           | Credits actually charged at settle.                                                                       |
| `montaj.credits.released_tenths` | counter | `1`  | `job_kind`, `plan`, `reason` | Credits returned on failure or cancellation.                                                              |
| `montaj.cogs.minor`              | counter | `1`  | `component`, `plan`          | Cost of goods sold in paise. `component` ∈ `asr`, `llm`, `gpu`, `render`, `storage`, `egress`, `payment`. |
| `montaj.revenue.minor`           | counter | `1`  | `plan`, `currency`           | Recognised revenue in paise.                                                                              |

**COGS per credit** — the headline number — is a recording rule, not a raw
metric, because it is a ratio of two counters over the same window:

```promql
sum(rate(montaj_cogs_minor_total[1h]))
  /
clamp_min(sum(rate(montaj_credits_settled_tenths_total[1h])) / 10, 1)
```

`05 §12` puts net revenue per credit at about ₹1.16 on the Creator plan, so the
alert threshold is **COGS per credit above ₹0.58** (a 50 % gross margin floor),
and the admin throttle in `05 §11` fires at 2× revenue.

## 7. Storage and lifecycle

| Metric                             | Type      | Unit       | Labels                              | Meaning                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | --------- | ---------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `montaj.storage.bytes`             | gauge     | `By`       | `bucket`, `tier`, `retention_class` | Bytes stored. `tier` ∈ `raw`, `derived`, `export`, `font`. `retention_class` ∈ `r7`, `r30`, `r90`, `r365` — the workspace plan's retention tier, not a key prefix. Storage lifecycle does not expire these objects (CONTRACTS section 6 keys are frozen); the scheduler sweeps them in B16, so a class that only grows is how a stalled sweep becomes visible. |
| `montaj.storage.egress.bytes`      | counter   | `By`       | `bucket`, `tier`                    | Bytes served. Should be ≈ 0 for the S3 raw bucket: derived objects go to R2 for zero egress (decision D35). A non-zero rate on `raw` is a bug worth an alert.                                                                                                                                                                                                  |
| `montaj.storage.lifecycle.deleted` | counter   | `{object}` | `bucket`, `rule`                    | Objects removed by a lifecycle rule. Evidence that the erasure promise in `05 §9` is real (decision D47).                                                                                                                                                                                                                                                      |
| `montaj.storage.upload.duration`   | histogram | `s`        | `tier`, `outcome`                   | Presigned upload duration as observed by the client.                                                                                                                                                                                                                                                                                                           |

## 8. Realtime

| Metric                        | Type            | Unit | Labels               | Meaning                                                                                                               |
| ----------------------------- | --------------- | ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `montaj.realtime.connections` | up/down counter | `1`  | `room_kind`          | Open WebSocket connections. `room_kind` ∈ `project`, `workspace`, `bridge`.                                           |
| `montaj.realtime.events`      | counter         | `1`  | `event`, `direction` | Events fanned out. `event` matches CONTRACTS section 7 (`edg.ops`, `job.progress`, `job.completed`, `comment.added`). |
| `montaj.edg.ops.applied`      | counter         | `1`  | `op_kind`, `outcome` | EDG ops applied. `outcome` ∈ `applied`, `rebased`, `rejected`.                                                        |

## 9. Traces

One trace per job, propagated through the queue so `api → queue → worker →
provider` is a single waterfall (`05 §11`).

Span attributes on the job span — attributes, not metric labels, so cardinality
is not a concern here:

| Attribute               | Example                 |
| ----------------------- | ----------------------- |
| `montaj.job.id`         | `01HQ...`               |
| `montaj.job.attempt_id` | `01HQ...`               |
| `montaj.job.key`        | `transcribe:01HQ...:v2` |
| `montaj.workspace.id`   | `01HQ...`               |
| `montaj.queue`          | `ai.transcribe`         |
| `montaj.provider`       | `elevenlabs`            |
| `montaj.model`          | `scribe-v2`             |
| `montaj.media.seconds`  | `312.4`                 |
| `montaj.cost.minor`     | `109`                   |
| `montaj.credits.tenths` | `52`                    |

Sampling: `parentbased_traceidratio` at 0.1 in production, 1.0 in staging (the
chart's `config.OTEL_TRACES_SAMPLER_ARG`). Job spans are **always** sampled
regardless of the ratio — a job that failed is exactly the trace you want, and
there are orders of magnitude fewer jobs than HTTP requests.

## 10. Prometheus naming

The OTel collector's Prometheus exporter rewrites these names: dots become
underscores, the unit is appended, and counters gain `_total`. So
`montaj.job.completed` (counter, `{job}`) is queried as
`montaj_job_completed_total`, and `http.server.request.duration` (histogram, `s`)
as `http_server_request_duration_seconds_bucket`. The dashboards and alert rules
in this folder use the Prometheus form throughout.
