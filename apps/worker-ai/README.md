# @montaj/worker-ai

Python 3.12 worker: the **official BullMQ Python** consumer for the `ai.*` queues,
provider adapters (ASR, alignment, diarisation), VAD and chunk planning, the eval
harness, and a small FastAPI control app for probes.

**Status:** A09 — `ai.vad`, `ai.transcribe`, `ai.align` and `ai.diarise` run end to
end with signed completion callbacks. Vendor adapters (ElevenLabs Scribe v2,
Sarvam Saaras v4, AssemblyAI), the model-backed aligners and pyannote diarisation
are **A10**; post-processing and transcript persistence are **A11**.

## Why Python here and nowhere else

The speech stack (pyannote, Silero, faster-whisper, DeepFilterNet, IndicWav2Vec)
is Python-only. Everything else in the monorepo is TypeScript, and the desktop
app deliberately ships no Python at all (decision D36) — it uses the native
`montaj-engine` sidecar instead.

## Setup

The pnpm scripts create and maintain `.venv` for you, so a fresh clone can run
`pnpm test` at the repo root with no Python setup step:

```bash
pnpm --filter @montaj/worker-ai setup     # explicit; also happens on first run
```

To use the raw commands from the brief, activate the venv first:

```powershell
cd apps\worker-ai
.\.venv\Scripts\Activate.ps1
python -m ruff check . ; python -m mypy --strict . ; python -m pytest -q
```

Override the base interpreter with `PYTHON=/path/to/python3.12`.

## Run

```bash
docker compose up -d                        # Redis from the repo root
pnpm --filter @montaj/worker-ai dev
```

On a healthy boot the worker logs one JSON line naming its queues, the enabled
providers and the VAD backend it loaded. The FastAPI control app answers on
`WORKER_AI_PORT` (default **8091**) and is **pod-internal** — never expose it.

| Route             | Purpose                                                       |
| ----------------- | ------------------------------------------------------------- |
| `GET /health`     | liveness; touches neither Redis nor a model                    |
| `GET /providers`  | every adapter, its enable flag and *why* it is off; routing    |
| `POST /evals/run` | stub (501); the harness is a CLI in A09                        |

## Queues

`worker_ai/queues.py` holds the CONTRACTS §3 queue table verbatim;
`apps/api/src/jobs/contracts/queue-names.test.ts` parses this file, so the two
copies cannot drift.

| Queue                                                    | A09                                       |
| -------------------------------------------------------- | ----------------------------------------- |
| `ai.vad`                                                 | Silero/energy VAD + the D14 chunk plan     |
| `ai.transcribe`                                          | route → per-chunk ASR → stable word ids    |
| `ai.align`                                               | the D13 aligner registry                   |
| `ai.diarise`                                             | whole-file speaker turns                   |
| `ai.translate` `ai.transliterate` `ai.clean` `ai.pass` `ai.llm` | consumed, and answered `worker/not_implemented` naming the WP that owns them |

The last row matters: a queue nobody consumes leaves jobs in Redis until the
API's queue-wait sweeper fails them half an hour later with no explanation.

## Callbacks and retries

Every job reports through the signed internal endpoints of CONTRACTS §3:

```
POST {API_ORIGIN}/internal/jobs/{jobId}/progress  {progress, etaMs?, message?}
POST {API_ORIGIN}/internal/jobs/{jobId}/complete  {status, result?, error?, usage?}

X-Montaj-Attempt:   <attemptId>
X-Montaj-Timestamp: <unix seconds>
X-Montaj-Signature: hex(hmac_sha256(INTERNAL_CALLBACK_SECRET, timestamp + "." + body))
```

`worker_ai/callbacks.py` serialises the body once, signs those exact bytes and
posts them — never a re-encoding, because `json.dumps` and `JSON.stringify`
disagree on separators. The worker always signs with the **primary**
`INTERNAL_CALLBACK_SECRET`; `INTERNAL_CALLBACK_SECRET_NEXT` is the API's second
*verification* key during a rotation, and a worker is rolled onto a new secret by
restarting it. Delivery is at-least-once and the API is idempotent on
`(jobId, attemptId)`, so a replay answers 200 `applied: false` and that is treated
as success.

**Retries are the subtle part.** A08 gives an `ai.*` job two BullMQ attempts, but
the `jobs` row has a single `attemptId` — so a failed completion posted on the
first attempt moves the row to `failed` and the API rejects the second attempt's
completion as `already_completed`. Hence:

| Failure                     | Completion posted            | Exception re-raised  |
| --------------------------- | ---------------------------- | -------------------- |
| retryable, attempts remain  | **no**                       | yes — BullMQ retries |
| retryable, final attempt    | yes, `finalAttempt: true`    | yes — BullMQ fails   |
| non-retryable, any attempt  | yes, `error.retryable:false` | yes                  |
| envelope does not parse     | no (there is no `jobId`)     | yes                  |

`finalAttempt` and `error.retryable: false` are the two flags
`markDeadLetterIfFinal` reads, so an exhausted job reaches the DLQ with its last
error attached.

## Layout

```
worker_ai/
  __main__.py        one BullMQ Worker per ai.* queue + uvicorn, in one process
  runtime.py         the handler: callbacks, retry semantics, service wiring
  settings.py        env validation mirroring loadEnv() from @montaj/config
  queues.py          frozen queue names + the pydantic job envelope (CONTRACTS §3)
  callbacks.py       signed progress/completion client
  storage.py         CONTRACTS §6 keys + a narrow boto3 wrapper (derived media)
  audio.py           wav decode, ffmpeg chunk cutting
  vad.py             Silero (ONNX) and energy backends, region post-processing
  chunking.py        the D14 chunk planner
  transcript.py      stable word ids, chunk assembly, the A11 post-process hook
  routing.py         loader/resolver for routing.yaml
  routing.yaml       the v2 routing table of 09 §1 as data
  logging_setup.py   one JSON line per record, matching the Node workers
  control.py         FastAPI: /health, /providers, /evals/run
  processors/        one module per queue
  providers/         Provider interface, registry, mock, local + serverless Whisper
  alignment/         the D13 registry: proportional + VAD, A10 shells above it
  diarisation/       the D13 registry: noop, pyannote shell
  evals/             manifest format, WER/CER, runner, CLI
  fixtures/          eval sets that ship with the worker
tests/               pytest + hypothesis
```

## The provider contract

`providers/base.py` is the interface every adapter implements. Its rules:

- **Word ids belong to the caller.** A provider returns words in order; the worker
  stamps `"<chunkIdx>:<n>"` onto them (CONTRACTS §2) and never reuses one.
- **Times are milliseconds.** A vendor that speaks seconds converts in its adapter
  and nowhere else.
- **`offset_ms` shifts a chunk into file time.** The provider sees a chunk that
  starts at zero; the result is already in file time.
- **Providers never touch storage or the database.** They return data; the caller
  persists it, so an adapter can be swapped or shadow-run for evals (D08).
- **Every external call is a `ProviderSubmission`** — `{provider, endpoint,
  artefact}` — which the completion payload carries so the API can write
  `provider_submissions` and honour a later erasure request.
- **Errors declare their retryability.** `ProviderError(retryable=False)` fails the
  job now; `True` lets BullMQ retry.
- `capabilities` is a `ProviderCapabilities` record (`word_timestamps`,
  `diarisation`, `max_duration_s`, `batch`, `languages`, plus the `supported` set)
  and `cost_estimate(seconds)` returns the list price in paise.

### Adapters today

| Adapter               | What it is                                              |
| --------------------- | ------------------------------------------------------- |
| `mock`                | deterministic words from a fixture; the CI/dev lane      |
| `local-whisper`       | faster-whisper in-process; optional extra `local-asr`    |
| `serverless-whisper`  | HTTP client for the D15 per-second GPU endpoint          |
| `elevenlabs` `sarvam` `assemblyai` | **A10** — capability and price metadata only |

### How A10 adds a vendor

1. Fill in the module under `providers/` — the class, its `capabilities` and its
   `cost_per_minute_inr` are already there and already tested.
2. Add its credential to the `unmet` check in `providers/registry.py:build_registry`
   (the pattern is one `credential(...)` line) and flip `implemented=True`.
3. Point a lane at it in `routing.yaml`. Nothing else changes: `routing.resolve`
   walks the lane in order and takes the first provider the deployment enables, so
   a vendor that is not configured is skipped with a reason rather than an error.
4. Add the vendor's fixtures to `evals/` and run the harness before changing any
   weight — `09 §8` blocks a routing change on a WER regression over one point.

## The routing table

`worker_ai/routing.yaml` is the v2 table of `03-architecture/09-ai-pipeline.md §1`
and decision **D12**, as data. The worker only reads it; admin editing of the
weights comes later. The weights are **not frozen** until the Hinglish eval set
exists (A00-05) — no vendor publishes a code-switch WER, so the ordering is
research, not measurement.

Lanes are matched in order on the detected language (exact tag, then base subtag),
and a code-mix signal wins outright. `alignment: required` marks a provider that
returns no word timings — Sarvam — so the worker runs the aligner registry behind
it. Override the file with `WORKER_AI_ROUTING_FILE`.

## VAD and chunking (D14)

A full-file VAD pass runs first, then chunks are planned at **nominal 10-minute
boundaries moved to the longest silence within ±30 s**, never mid-region and never
overlapping. `worker_ai/chunking.py` documents the four fallbacks in order.

The Silero v5 ONNX model is **not committed**. Point `WORKER_AI_VAD_MODEL` at
`silero_vad.onnx` (the CPU image bakes it in) and the worker uses it; without it
the deterministic energy backend runs instead, which is what CI and the chunk
planner's tests use. `GET /providers` reports which one loaded.

## Where the transcript goes

`ai.transcribe` completes with `{ chunks[], language, provider, model, lane,
providerSubmissions[] }` in the callback's `result`, which the API stores in
`jobs.result`. `POST /internal/transcripts/{transcriptId}/chunks` does not exist on
`main`, so **A11 owns persistence**: the payload is already shaped like
`transcript_chunks` (`06`), including `nextWordSeq`, so wiring it up is one
function — `_result` in `processors/transcribe.py`.

## Evals

```bash
python -m worker_ai.evals list
python -m worker_ai.evals run --set fixtures/hinglish-mini
python -m worker_ai.evals run --set hinglish-mini --json --max-wer 0.15
```

`--max-wer` exits 1 on a regression, which is the hook `09 §8` needs to block a
routing change. A set is a directory under `fixtures/` with a `manifest.yaml`
(format in `evals/manifest.py`); `audioAvailable: false` says the references are
real and the media has not shipped yet, so a provider that reads audio skips the
set and the mock still exercises the harness. The real sets arrive with **A00-05**.

## Configuration

`docs/CONTRACTS.md` §1 variables are read through `settings.py`, which fails fast
and names every offending variable without ever echoing a value (THREAT-MODEL T21).

These are **deployment naming**, read straight from the process environment and
deliberately *not* in CONTRACTS §1 — the same precedent the API set for
`MONTAJ_QUEUE_PREFIX` and the OpenTelemetry variables:

| Variable                 | Default        | Meaning                                        |
| ------------------------ | -------------- | ---------------------------------------------- |
| `MONTAJ_QUEUE_PREFIX`    | `bull`         | Redis key prefix; must match the API's          |
| `WORKER_AI_CONCURRENCY`  | `4`            | jobs in flight per queue                        |
| `WORKER_AI_PORT`         | `8091`         | control app port (pod-internal)                 |
| `WORKER_AI_QUEUES`       | every `ai.*`   | pin a pool to a subset, e.g. a GPU pool         |
| `WORKER_AI_ROUTING_FILE` | packaged       | override `routing.yaml`                         |
| `WORKER_AI_VAD_MODEL`    | —              | path to `silero_vad.onnx`                       |
| `WORKER_AI_WHISPER_MODEL`| `small`        | faster-whisper model for the local adapter      |
| `WORKER_AI_ALLOW_MOCK`   | auto           | force the mock lane on or off                   |
| `GPU_PROVIDER_URL`       | —              | serverless GPU endpoint (D15)                   |
| `GPU_PROVIDER_TOKEN`     | —              | bearer token for it                             |
| `FFMPEG_BIN` `FFPROBE_BIN` | on `PATH`    | explicit binary paths                           |

`GPU_PROVIDER_URL` is a **raise for the orchestrator**: CONTRACTS §1 freezes
`GPU_PROVIDER` but not its endpoint, and A09 may not edit that file. It is
documented here until §1 gains it.

Provider enablement is `credential present` AND `feature flag not off`. Flags come
from `FEATURE_FLAGS_JSON` and are named `asr.<provider>`.

## Dependencies

`pyproject.toml` holds the direct, exactly-pinned dependencies;
`requirements.lock` (runtime) and `requirements-dev.lock` (runtime + dev) are
pip-tools output and are what actually gets installed. After editing
`pyproject.toml`:

```bash
pnpm --filter @montaj/worker-ai lock
```

`faster-whisper` is the optional `local-asr` extra: it pulls in CTranslate2 and
downloads model weights on first use, so it is installed by the CPU Docker image
and skipped in CI. `LocalWhisperProvider` imports it lazily and the registry
reports it as unavailable when it is missing.

`bullmq` is pinned per `docs/CONTRACTS.md` §3. Features the Python client does not
support — flow producers, repeatable jobs, sandboxed processors — are documented
there as **not used**, so the Node producers must not rely on them.

## Docker

```bash
docker build -f apps/worker-ai/Dockerfile apps/worker-ai
```

The CPU image carries ffmpeg, onnxruntime, faster-whisper and the Silero model.
`Dockerfile.gpu` documents the serverless-GPU image contract (D15) and is a
placeholder until A10 builds it.

## Quality gates

| Command                                     | Gate                                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| `pnpm --filter @montaj/worker-ai lint`      | ruff (pyflakes, isort, bugbear, bandit, annotations) |
| `pnpm --filter @montaj/worker-ai typecheck` | `mypy --strict`                                      |
| `pnpm --filter @montaj/worker-ai test`      | pytest + hypothesis, with the CONTRACTS §9 coverage gate |

Two markers gate the slow paths: `slow` (a real model download; `RUN_SLOW=1`) and
`integration` (the compose stack and a running API; `RUN_INTEGRATION=1`). See
`tests/test_integration.py` for what the integration run needs.

`tests/test_queues.py` and `tests/test_settings.py` parse the TypeScript sources
directly, so the Python queue names and env contract cannot drift from the Node
side without failing CI.
