# apps/model-server — the GPU model server

FastAPI + uvicorn. Serves `/transcribe`, `/align`, `/diarise` and
`/detect-language` on one GPU, with Whisper, the forced aligners and pyannote
**co-resident** so a transcript never crosses an instance boundary mid-file
(decision **D15**).

Its only client is `apps/worker-ai`, through three adapters that already exist:
`providers/serverless_whisper.py`, `diarisation/pyannote.py` and `lid.py`. The
wire contract is theirs, not this app's, and the recorded session in
`apps/worker-ai/worker_ai/fixtures/vendor/gpu-whisper/session.json` is what
`tests/test_contract_fixtures.py` checks every response against.

---

## Routes

Times on the wire are **seconds** everywhere except `detect-language`'s
`windows`, which is `[[startMs, endMs], …]` — milliseconds — because that is what
`worker_ai/lid.py` already sends. Matching the client beat tidying the contract.

All four require `Authorization: Bearer $GPU_PROVIDER_TOKEN`. Unknown request
fields are **ignored, never rejected**: the worker splats its routing options into
the body, so a server that 422'd on an option it had not shipped yet would break
every rollout.

### `POST /transcribe`

faster-whisper `large-v3-turbo` (CTranslate2), fp16 on a card and int8 on CPU.
Word timestamps, a language hint, and beam and temperature from the request.
Input is one VAD-trimmed chunk of at most `MODEL_SERVER_MAX_AUDIO_SECONDS`
(600 s — `09 §1` cuts chunks at ten minutes). **This is the batched route.**

```jsonc
// request
{ "audio": "https://…/audio16k.wav", "language": "hi", "wordTimestamps": true,
  "model": "large-v3-turbo", "hints": ["Aksharo"], "beamSize": 5,
  "temperature": [0.0, 0.2], "vadFilter": false }

// 200
{ "language": "hi", "languageProbability": 0.91, "durationS": 41.2,
  "model": "large-v3-turbo", "requestId": "01J…",
  "words": [{ "start": 0.12, "end": 0.44, "word": "toh", "probability": 0.9 }],
  "segments": [{ "start": 0.0, "end": 4.1, "text": "…" }],
  "engineVersions": { "asr": "large-v3-turbo", "asr.licence": "MIT …" },
  "usage": { "gpuSeconds": 2.1, "audioSeconds": 41.2, "model": "large-v3-turbo", "batchSize": 4 } }
```

`hints` become Whisper's `initial_prompt`, which is the glossary-boosting hook of
`09 §3`.

### `POST /align`

CTC forced alignment. **Decision D77** fixes which checkpoint by language:
IndicWav2Vec (MIT) for Indic, XLSR-53 CTC fine-tunes (Apache-2.0) for everything
else, and **MMS never**, because the widely distributed export is CC-BY-NC-4.0.

The word shape is deliberately identical to `/transcribe`'s, so the worker's
existing `_words()` parser reads it unchanged.

```jsonc
// request
{ "audio": "…", "words": ["toh", "aaj", "hum"], "language": "hi",
  "startS": 0.0, "endS": 41.2 }

// 200
{ "language": "hi", "model": "ai4bharat/indicwav2vec/hi", "licence": "MIT",
  "durationS": 41.2, "requestId": "01J…",
  "words": [{ "start": 0.12, "end": 0.44, "word": "toh", "probability": 1.0 }],
  "skipped": [], "engineVersions": { … }, "usage": { … } }
```

**Script projection is the caller's job.** Roman-script Hinglish has to become
Devanagari before an IndicWav2Vec vocabulary can tokenise it (`09 §2`), and the
table that does it lives in `worker_ai/alignment/romanisation.py` with IndicXlit
queued behind it as A22's work. This server tokenises what it is given and lists
in `skipped` any word the vocabulary could not represent. Guessing a projection
here would put two disagreeing transliteration tables in one pipeline.

### `POST /diarise`

pyannote community-1, run over the **whole file**, never per chunk, so speaker
ids survive the chunk boundaries the VAD planner introduces (`09 §2`). Not
batched: one call holds one whole file, and its memory reservation asks for twice
what transcription does per audio-second.

```jsonc
// request
{ "audio": "…", "numSpeakers": 2, "minSpeakers": 1, "maxSpeakers": 8 }

// 200
{ "model": "pyannote/speaker-diarization-community-1",
  "turns": [{ "speaker": "SPEAKER_00", "start": 0.0, "end": 2.15 }],
  "requestId": "01J…", "durationS": 41.2,
  "engineVersions": {
    "diarise": "pyannote/speaker-diarization-community-1",
    "diarise.licence": "CC-BY-4.0",
    "diarise.attribution": "Speaker diarisation by pyannote speaker-diarization-community-1 (Herve Bredin et al., CC-BY-4.0)."
  },
  "usage": { … } }
```

> **Attribution is not optional.** community-1 is CC-BY-4.0: commercial use
> **with attribution**. The string above is byte-identical to
> `worker_ai.diarisation.pyannote.PYANNOTE_ATTRIBUTION`, and a test asserts they
> match, because two copies of an attribution that drift are two chances to ship
> the wrong one.

`SPEAKER_00` stays `SPEAKER_00` on this wire; the worker maps it to the EDG's
opaque `S1`/`S2`. That mapping belongs to the caller, because pyannote's
numbering must never reach a caption and the caller is the side that knows what a
caption is.

### `POST /detect-language`

faster-whisper LID over the caller's windows, or the first 30 s when it names
none. Per-window verdicts are pooled by window length, so a confident two-second
window cannot outvote a hesitant minute.

```jsonc
// request
{ "audio": "…", "windows": [[0, 60000], [120000, 135000]],
  "textSignal": { "language": "hi-en", "confidence": 0.62 } }

// 200
{ "language": "hi", "probability": 0.88, "model": "large-v3-turbo",
  "requestId": "01J…",
  "windows": [{ "startMs": 0, "endMs": 60000, "language": "hi", "probability": 0.9 }],
  "textSignal": { "language": "hi-en", "confidence": 0.62 },
  "engineVersions": { … }, "usage": { … } }
```

`language` and `probability` are the **audio** verdict and nothing else.
`09 §1` requires two signals that agree before a code-mix lane is chosen, and the
agreement rule lives in the caller (`worker_ai.lid`); a server that quietly folded
the caller's own text signal into its answer would make that rule check a number
against itself. So `textSignal` comes back exactly as it was sent — a passthrough,
so one round trip carries both signals.

### Health, readiness, metrics

| Route      | Auth | What it means                                                                                                                                                                  |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz` | no   | The process is up. Touches no model, so a worker mid-load is alive and not killed by a probe.                                                                                  |
| `/readyz`  | no   | Every backend in `MODEL_SERVER_PRELOAD` is resident **and** we are not draining. 503 otherwise, with the reason in the body.                                                   |
| `/metrics` | no   | Prometheus text. Carries no user data — the cardinality rules forbid every id that could — and a scrape config that needs a rotating token is one that silently stops working. |

---

## Errors

CONTRACTS §8 envelope throughout: `{ "error": { "code", "message", "details?", "requestId" } }`,
codes in `model-server/slug` form. The status code is what the client routes on
(`worker_ai/providers/http.py` retries 429 and 5xx and nothing else), so:

| Status | Code                             | When                                                              | Retryable |
| ------ | -------------------------------- | ----------------------------------------------------------------- | --------- |
| 401    | `model-server/unauthorized`      | Missing or wrong bearer token.                                    | no        |
| 413    | `model-server/payload-too-large` | Body or audio over the limit.                                     | no        |
| 422    | `model-server/invalid-request`   | Body does not match the route's schema.                           | no        |
| 422    | `model-server/bad-audio`         | Unfetchable, undecodable, or longer than the chunk cap.           | no        |
| 503    | `model-server/overloaded`        | Memory guard, or the worker is draining. **`Retry-After` set.**   | yes       |
| 503    | `model-server/model-unavailable` | A backend is not resident, or has no checkpoint for the language. | yes       |

---

## Batching, and why it is not optional

`infra/gpu/COST.md §2` derives ₹0.19 per media minute _without_ batching against
the ₹0.09–0.13 band in `05 §12`, and closes the gap with one lever: "batched
chunks keeping the card busy across requests". **Decision D74** makes that
explicit — the band holds only with request batching. So batching is the reason
the cost band is reachable, not an optimisation for later.

**How it works.** One consumer task for `/transcribe`. A request joins a queue and
the consumer takes items for up to `MODEL_SERVER_BATCH_WINDOW_MS` (50 ms) or until
`MODEL_SERVER_BATCH_MAX_SIZE` (8) are in hand, then hands the whole group to the
ASR backend as one call.

**What that buys, precisely.** CTranslate2 batches _within_ one audio; its public
API takes one audio at a time. So the group is executed inside a single hand-off
under a single model lock, with `batch_size` set to the group size. That
eliminates per-request lock and context churn, amortises the encoder warm-up
across the group, and keeps the card from idling between two requests that
arrived 5 ms apart. It does **not** buy cross-request tensor fusion — faster-whisper
exposes no way to concatenate two different audios into one decoder call, and
padding them into one array would corrupt the timings that are the entire point
of this endpoint.

**The cost.** A lone request pays the window — 50 ms — because the consumer cannot
know nothing is arriving 5 ms behind it without waiting to find out. Against a
ten-minute chunk that is noise; `model_server_batch_wait_seconds` measures it so
a mis-set window is visible rather than inferred.

**On CPU, batching makes things worse.** Measured, in `cost.md §2`: CTranslate2 on
CPU already uses every core, so grouping adds contention with no idle hardware to
fill. Run the CPU lane with `MODEL_SERVER_BATCH_MAX_SIZE=1`. This says nothing
about the GPU, where a single stream leaves the card substantially idle — that is
the number the first real run has to produce.

`/align`, `/diarise` and `/detect-language` are **not** batched: alignment is
milliseconds of Viterbi against a chunk already transcribed, and diarisation is
one whole-file call whose footprint makes a second concurrent one a bad idea.

---

## Lifecycle: warm models, and a drain that is actually graceful

- **`MODEL_SERVER_PRELOAD` selects what loads**, not merely what gates readiness:
  a CPU worker that only transcribes never pays to page pyannote into memory,
  and its `/diarise` answers 503 naming the variable rather than pretending.
- **Models load once, at startup**, from the weights baked into the image. No
  request ever triggers a load; `tests/test_lifecycle.py` asserts it. The
  difference is a 25-to-40-second cold start paid once against one paid per
  request (`infra/gpu/COST.md §4`).
- **A backend that fails to load does not take the process down.** On a serverless
  worker a hard exit is a crash loop that still bills. The failure is recorded,
  `model_server_model_ready` stays at 0 for that model, its routes answer 503 with
  the reason, and the other two keep serving. A worker that can transcribe but not
  diarise is strictly better than neither.
- **SIGTERM flips readiness first.** uvicorn's own graceful shutdown begins by
  refusing new connections and only then runs the lifespan shutdown; behind a load
  balancer that window is long enough to route a request to a worker that is about
  to stop. The handler in `__main__.py` sets the drain flag immediately, so
  `/readyz` returns 503 and traffic moves away, then in-flight work finishes and
  the batcher drains in order.

## The memory guard

A 24 GB card holding all three models has roughly 18 GB of working room. Without
a guard, the failure mode is a CUDA out-of-memory _inside_ the model call: the
request dies, often the process with it, taking every other in-flight request down
and costing a cold start.

So a request reserves an estimate — `MODEL_SERVER_MEMORY_BYTES_PER_AUDIO_SECOND`
times its audio seconds, plus a per-request floor — before the model call, and is
refused with **503 + `Retry-After`** when it does not fit. The client already
treats 5xx as retryable and already obeys `Retry-After`, so a refusal costs a wait
rather than a job.

The estimate is deliberately crude, because it only has to be monotonic in the
thing that actually grows and **deterministic**. What it is not modelling is
visible on the dashboard: `model_server_memory_reserved_bytes` against
`montaj.gpu.memory.used`.

---

## Models and licences

| Role                | Model                                         | Licence                             | Decision          |
| ------------------- | --------------------------------------------- | ----------------------------------- | ----------------- |
| Transcription + LID | faster-whisper `large-v3-turbo` (CTranslate2) | MIT                                 | D15               |
| Alignment, Indic    | AI4Bharat IndicWav2Vec CTC                    | MIT                                 | D77               |
| Alignment, global   | XLSR-53 CTC fine-tunes                        | Apache-2.0                          | D77               |
| Diarisation         | pyannote `speaker-diarization-community-1`    | **CC-BY-4.0, attribution required** | D13, D77          |
| ~~Alignment, MMS~~  | ~~`facebook/mms-300m-1130-forced-aligner`~~   | ~~CC-BY-NC-4.0~~                    | **excluded, D77** |

MMS is not merely unused: `scripts/bake_models.py` fails the image build if any
argument names an MMS checkpoint, so the licence decision cannot be undone by a
passing `--build-arg`. Counsel confirms the table before launch (HUMAN-ACTIONS
H-14).

The CTC checkpoints are exported to ONNX at image-build time and read at runtime
through onnxruntime, in the same directory layout
`worker_ai/alignment/ctc.py` reads:

```
$MODEL_SERVER_ALIGN_MODEL_DIR/<family>/<language>/model.onnx
$MODEL_SERVER_ALIGN_MODEL_DIR/<family>/<language>/vocab.json
$MODEL_SERVER_ALIGN_MODEL_DIR/<family>/<language>/config.json   # optional {"frameMs": 20}
```

Two apps, one layout, so a checkpoint that works on the worker's CPU fallback rung
works on the GPU rung unchanged — and `transformers`/`torch` stay out of the
inference path for alignment.

---

## Configuration

`GPU_PROVIDER_TOKEN` is CONTRACTS §1; everything else is `MODEL_SERVER_*`.
`COMPUTE_TYPE` and `HF_HOME` are honoured as fallbacks because X05's
`infra/gpu/runpod/endpoint.json` already sets them.

| Variable                                     | Default                                    | Meaning                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GPU_PROVIDER_TOKEN`                         | —                                          | The bearer token. **Required**; see below.                                                                                                           |
| `MODEL_SERVER_ALLOW_ANONYMOUS`               | `0`                                        | Start with no token. Local development only.                                                                                                         |
| `MODEL_SERVER_DEVICE`                        | `cuda`                                     | `cuda` or `cpu`.                                                                                                                                     |
| `MODEL_SERVER_COMPUTE_TYPE`                  | `float16` on cuda, `int8` on cpu           | CTranslate2 compute type.                                                                                                                            |
| `MODEL_SERVER_WHISPER_MODEL`                 | `large-v3-turbo`                           | ASR and LID checkpoint.                                                                                                                              |
| `MODEL_SERVER_DIARISER_MODEL`                | `pyannote/speaker-diarization-community-1` | Diarisation pipeline.                                                                                                                                |
| `MODEL_SERVER_ALIGN_MODEL_DIR`               | —                                          | Root of the exported CTC heads. Unset means `/align` is 503.                                                                                         |
| `MODEL_SERVER_PRELOAD`                       | `asr`                                      | Which backends are **loaded**, and therefore gate `/readyz`. One left out is never instantiated and its routes answer 503. The image sets all three. |
| `MODEL_SERVER_HOST` / `MODEL_SERVER_PORT`    | `0.0.0.0` / `8000`                         |                                                                                                                                                      |
| `MODEL_SERVER_MAX_BODY_MB`                   | `64`                                       | Request body ceiling.                                                                                                                                |
| `MODEL_SERVER_MAX_AUDIO_SECONDS`             | `600`                                      | Chunk ceiling (`09 §1`).                                                                                                                             |
| `MODEL_SERVER_BATCH_MAX_SIZE`                | `8`                                        | Requests per model call. `1` disables batching.                                                                                                      |
| `MODEL_SERVER_BATCH_WINDOW_MS`               | `50`                                       | How long the batcher waits for company.                                                                                                              |
| `MODEL_SERVER_MEMORY_BUDGET_MB`              | `18432` on cuda, `4096` on cpu             | The memory guard's ceiling.                                                                                                                          |
| `MODEL_SERVER_MEMORY_BYTES_PER_AUDIO_SECOND` | `3145728`                                  | The guard's per-audio-second estimate.                                                                                                               |
| `MODEL_SERVER_MEMORY_RETRY_AFTER_S`          | `5`                                        | The `Retry-After` on a 503.                                                                                                                          |
| `MODEL_SERVER_DRAIN_TIMEOUT_S`               | `30`                                       | How long in-flight work gets after SIGTERM.                                                                                                          |
| `MODEL_SERVER_MODE`                          | `http`                                     | `http` runs uvicorn; `runpod` runs the queue handler.                                                                                                |
| `MODEL_SERVER_RUNPOD_REQUIRE_TOKEN`          | `0`                                        | Also demand the token inside the RunPod event.                                                                                                       |

> **An unauthenticated model server refuses to boot.** With `GPU_PROVIDER_TOKEN`
> empty and `MODEL_SERVER_ALLOW_ANONYMOUS` unset, the process exits 2 with a
> readable message. A container that starts anyway is a GPU that anyone who finds
> the URL can spend, and "we meant to set the token" is not a control.

---

## Packaging

### `Dockerfile`

Multi-stage, built from `apps/model-server` as the context:

| Target                                  | Base                                           | For                                                                                                                               |
| --------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `cpu`                                   | `python:3.12-slim-bookworm`                    | CI. No CUDA, no weights, no HF token; proves the lock resolves, the app installs and `/healthz` answers. Runs as a non-root user. |
| `base` → `models` → `runtime` (default) | `nvidia/cuda:12.6.2-cudnn-runtime-ubuntu22.04` | Production. Installs `requirements-gpu.lock`, bakes every weight, ships offline.                                                  |

```bash
# CPU smoke, no secret needed
docker build -f apps/model-server/Dockerfile --target cpu -t aksharo/model-server:cpu apps/model-server

# The real image (HF_TOKEN is a BuildKit secret; it must never land in a layer)
printf '%s' "$HF_TOKEN" > /tmp/hf_token
DOCKER_BUILDKIT=1 docker build -f apps/model-server/Dockerfile \
  --secret id=hf_token,src=/tmp/hf_token \
  -t "$REGISTRY/montaj/gpu-model-server:$TAG" apps/model-server
shred -u /tmp/hf_token
```

`HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` are set at run time on purpose: a
missing weight must fail the container on boot, not quietly reach out to
huggingface.co from inside a GPU worker holding user media.

### Lock files

Three, compiled by pip-tools from `pyproject.toml` (`pnpm --filter @montaj/model-server lock`):

| File                    | Extras                                      | Installed by                                                                                                                 |
| ----------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `requirements.lock`     | `asr`, `align`                              | The `cpu` image target.                                                                                                      |
| `requirements-gpu.lock` | `asr`, `align`, `diarise`, `bake`, `runpod` | The CUDA image, at build time and run time. This is what replaced X05's non-existent `apps/worker-ai/requirements-gpu.lock`. |
| `requirements-dev.lock` | `dev`, `asr`, `align`                       | Local development and CI.                                                                                                    |

The GPU lock is separate so a laptop and a CI runner never install torch and
pyannote to run the tests.

### RunPod and Modal

- **RunPod queue endpoints** (`MODEL_SERVER_MODE=runpod`): `model_server/runpod_handler.py`
  builds the same app, runs its lifespan — which is what loads the models and
  starts the batcher — and dispatches `{"input": {"route": "…", "body": {…}}}` to
  the same `ModelService`. Not a second implementation: the same batcher, the same
  memory guard, the same warm models.
- **RunPod load-balancing endpoints and Modal** (`MODEL_SERVER_MODE=http`): plain
  uvicorn. `infra/gpu/modal/app.py` builds the image and exposes the ASGI app.

`infra/gpu/runpod/endpoint.json` (GPU class, regions, warm floor, autoscaling) is
X05's and unchanged apart from its `env` block, which now names this app's
variables.

---

## Development

```bash
pnpm --filter @montaj/model-server setup        # create .venv, install requirements-dev.lock
pnpm --filter @montaj/model-server lint         # ruff check
pnpm --filter @montaj/model-server typecheck    # mypy --strict
pnpm --filter @montaj/model-server test         # pytest + the coverage gate
pnpm --filter @montaj/model-server test:slow    # RUN_SLOW=1 lane; downloads faster-whisper tiny
```

Run it locally against fakes-free real code:

```bash
GPU_PROVIDER_TOKEN=dev-token MODEL_SERVER_DEVICE=cpu MODEL_SERVER_WHISPER_MODEL=tiny \
MODEL_SERVER_BATCH_MAX_SIZE=1 \
  pnpm --filter @montaj/model-server dev
```

### The test suite, and what each layer is for

| File                        | Proves                                                                                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_contract_fixtures.py` | Every response is a superset, with matching types, of A10's recorded session — and the pyannote attribution matches the worker's constant by value. |
| `test_worker_adapter.py`    | `apps/worker-ai`'s own three clients, over a real socket, against a real uvicorn. The only test that fails when the two apps disagree.              |
| `test_routes.py`            | Wire shapes, request options reaching the model, unknown fields ignored.                                                                            |
| `test_auth.py`              | 401 before validation; health and metrics unauthenticated; an empty token refusing to boot.                                                         |
| `test_batching.py`          | ≥ 2 chunks per model call under concurrent load; failures scoped to one group; the window as a bound.                                               |
| `test_memory_guard.py`      | Deterministic 503 with `Retry-After`; reservations released on failure.                                                                             |
| `test_lifecycle.py`         | Load once at startup; one broken backend does not stop the others; drain ordering.                                                                  |
| `test_ctc_alignment.py`     | The Viterbi maths against hand-written emission matrices, including the repeated-character blank.                                                   |
| `test_backends.py`          | The real backends' parsing, against library-shaped stubs.                                                                                           |
| `test_cpu_end_to_end.py`    | `RUN_SLOW=1`: a real `tiny` model on the five-second clip, and the measured RTF in `cost.md`.                                                       |

Coverage is gated at **75 lines / 70 branches** (CONTRACTS §9) by
`scripts/coverage_gate.py`, which checks the two numbers separately —
`--cov-fail-under` blends them, and a run with 95 % of lines and 40 % of branches
would pass a blended gate while failing the contract.

The five-second fixture clip is **synthesised, not speech**. It proves the
pipeline, never the quality; word accuracy needs the hand-labelled sets of
`09 §8`, which are A00-05's deliverable.

---

## Observability

Metric names are registered in `infra/observability/METRICS.md` §11 and are as
frozen as a route. They are the only names in that file without the `montaj.`
prefix, because this process is scraped **directly** — a RunPod or Modal sandbox
has no OTel collector beside it — so what the code defines is what a scrape
returns, in native Prometheus form.

Logs are one JSON object per line. Two things never reach stdout: a credential
(the bearer token, an HF token, a presigned URL's query string — THREAT-MODEL
T21) and **audio or transcript text**. A GPU worker holds user media for the
length of one request and writes none of it anywhere, which is the
`retentionClass: ephemeral` the worker records against every submission; a log
line with a transcript in it silently breaks that promise. `logging_setup.safe_extra`
is the chokepoint and `safe_uri` reduces a presigned URL to scheme, host and path.
