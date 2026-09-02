# Cost accounting for the model server

The arithmetic behind `usage {gpuSeconds, audioSeconds, model, batchSize}`, the
numbers measured so far, and the table to fill in from the first real GPU run.
`infra/gpu/COST.md` holds the fleet-level model; this file holds the per-request
one and the measurements that will replace X05's assumptions.

**Decision D74** says the ₹0.09–0.13 per media minute band in `05 §12` is a
target, not a fact: X05's re-derivation gives ₹0.19 without batching, and the
band "holds only with request batching and ~10-minute chunks". So the whole point
of this file is to make the batching assumption falsifiable.

## 1. What the server reports, and how it is computed

Every response carries a `usage` block:

| Field          | Meaning                                                                | Source                                        |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------- |
| `audioSeconds` | Media seconds decoded and processed.                                   | The decoded PCM, not the caller's claim.      |
| `gpuSeconds`   | Model-call seconds **attributed to this request**.                     | `compute_s / batchSize` — see below.          |
| `model`        | The checkpoint that produced the answer.                               | The loaded backend, not the requested string. |
| `batchSize`    | How many requests were coalesced into the model call this one rode in. | The dynamic batcher.                          |

### Why `gpuSeconds` is divided by `batchSize`

A group of four chunks that took 8 seconds of wall clock did not cost 32
GPU-seconds; the card was busy once, for 8 seconds, and each request is charged 2.
Charging each request the whole group's duration would inflate `montaj.cogs.minor`
— and therefore the COGS-per-credit panel in `05 §11` — by exactly the batching
factor, which is precisely the quantity D74 exists to measure. `batchSize` is on
the wire beside `gpuSeconds` so the division can be audited by the caller rather
than trusted.

`audioSeconds` is measured, not declared: a caller that says "this is 60 seconds"
and sends 600 is billed for 600.

### What `gpuSeconds` is not

It is **wall-clock time inside the model call**, not SM-busy time. On a warm
worker with one stream they are close; on a worker serving two streams, wall clock
over-counts. The fleet-level correction is `montaj.gpu.utilization` and
`montaj.gpu.seconds.billed` (METRICS.md §5), which is what the provider actually
invoices. Reconciling the two is the first job of the first real GPU run.

## 2. Measured: CPU, `tiny`, int8 — the only numbers that exist today

Machine: the development laptop this work package was built on (Windows 11,
no GPU). Model `tiny`, `MODEL_SERVER_DEVICE=cpu`, `compute_type=int8`, beam 1.
Audio: `apps/worker-ai/worker_ai/fixtures/speech-5s/clip.wav`, 5.00 s.

| Measurement                         | Run 1              | Run 2              | Note                                                     |
| ----------------------------------- | ------------------ | ------------------ | -------------------------------------------------------- |
| Model load at startup               | 1.83 s             | 1.78 s             | Once, at startup — never per request.                    |
| Serial RTF (3 sequential requests)  | 1.31 / 0.94 / 0.95 | 0.98 / 1.60 / 1.63 | First call includes CTranslate2's own warm-up.           |
| Serial RTF, median                  | **0.95**           | **1.60**           | The spread is the machine, not the model.                |
| Batched RTF (4 concurrent, batch 4) | **1.42**           | **1.81**           | Per request, after dividing the group's wall clock by 4. |
| Batch size achieved under load      | 4 / 4              | 4 / 4              | `MODEL_SERVER_BATCH_MAX_SIZE=4` in the harness.          |

Reproduce with `RUN_SLOW=1 python -m pytest tests/test_cpu_end_to_end.py -q -s`,
which prints the single-request line and asserts the batch reached ≥ 2.

### The finding that matters: on CPU, batching costs rather than saves

Batched RTF is consistently **worse** than serial RTF (1.42 against 0.95; 1.81
against 1.60), and the reason is not subtle: CTranslate2 on CPU already spreads
one request across every core, so a second concurrent request has no idle
hardware to use. Grouping four of them serialises them behind one model lock and
adds contention on top, so each request's attributed share exceeds what it would
have cost alone.

**This does not falsify D74**, and it must not be read as if it does:

- The D74 assumption is about a **GPU**, where a single Whisper stream leaves the
  card substantially idle between decoder steps and a second stream fills it.
  A CPU that is already at 100 % utilisation is the one machine where batching
  cannot help, and it is the only machine available here.
- What the CPU run _does_ establish is that the machinery works: groups of four
  form under load, the attribution divides correctly, and
  `model_server_batch_size` reports what actually happened.

The consequence for deployment is a real one, though: **the CPU fallback lane
should run with `MODEL_SERVER_BATCH_MAX_SIZE=1`**, which disables grouping
entirely and costs nothing else. That is not the serverless GPU configuration and
it is not what `infra/gpu/runpod/endpoint.json` sets.

### What these numbers cannot tell you

`tiny` on CPU bounds nothing about `large-v3-turbo` on an L4, and the fixture clip
is **synthesised, not speech** (`fixtures/speech-5s/README.md`): Whisper's
behaviour on non-speech includes temperature fallback and repetition loops, which
is visible in the spread above and would not happen on real creator audio. No
routing weight, cost band or capacity plan may move on the strength of this
table.

## 3. To be filled by the first real GPU run

The harness is the same: run the image on one 24 GB card, send N ten-minute
VAD-trimmed chunks, and read `usage` plus `/metrics`.

| Input                                   | D74 / COST.md assumption               | Measured | Source of the measurement                           |
| --------------------------------------- | -------------------------------------- | -------- | --------------------------------------------------- |
| GPU class                               | 24 GB Ada / Ampere (L4, A5000, A10)    | _TBD_    | `runpod/endpoint.json` `gpuIds`                     |
| Cold start: image pull (flashboot)      | 5–10 s                                 | _TBD_    | provider metrics                                    |
| Cold start: model load into VRAM        | 15–25 s                                | _TBD_    | `model_server_model_load_seconds`                   |
| RTF, `large-v3-turbo`, fp16, unbatched  | 0.055                                  | _TBD_    | `model_server_realtime_factor{route="/transcribe"}` |
| RTF, batched at 4                       | (implied ≈ 0.028)                      | _TBD_    | same, under concurrent load                         |
| Median batch size under production load | ≥ 2                                    | _TBD_    | `model_server_batch_size`                           |
| Alignment + diarisation overhead        | +35 % of the ASR pass                  | _TBD_    | `model_server_compute_seconds_total` by `route`     |
| VRAM in use, three models resident      | ~11 GB                                 | _TBD_    | `montaj.gpu.memory.used`                            |
| Effective GPU seconds per media minute  | 4.5 s                                  | _TBD_    | `compute_seconds_total / (audio_seconds_total/60)`  |
| **Cost per media minute**               | **₹0.19 unbatched, ₹0.09–0.13 target** | _TBD_    | the row above × the provider's per-second rate      |

The PromQL for the headline number, once the fleet is scraped:

```promql
sum(rate(model_server_compute_seconds_total{route="/transcribe"}[1h]))
  /
clamp_min(sum(rate(model_server_audio_seconds_total{route="/transcribe"}[1h])) / 60, 1)
```

That is GPU-seconds per media minute; multiply by the provider's per-second rate
and by ₹95/USD to get the cell `05 §12` cares about.

## 4. What to do with the answer

D74 already names the trigger: **if the measured cost sits near ₹0.19 rather than
the ₹0.09–0.13 band, routing weights move toward AssemblyAI (₹0.24) for global
languages and the warm floor is reconsidered.** Two things to check before
concluding that, both of which this server now measures:

1. **Is the median batch size above 1?** If it is 1 under real load, the arrival
   pattern is too sparse for a 50 ms window and the lever D74 depends on is not
   engaged. Widening `MODEL_SERVER_BATCH_WINDOW_MS` trades latency for cost, and
   `05 §5.1`'s p95 of 120 s has room for tens of milliseconds.
2. **Is `/diarise` dominating?** It is whole-file and unbatched by design
   (`09 §2`), so a workload with diarisation on every job has a different cost
   shape from one without. Split the counters by `route` before blaming ASR.
