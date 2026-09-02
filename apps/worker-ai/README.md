# @montaj/worker-ai

Python 3.12 worker: the **official BullMQ Python** consumer for the `ai.*` queues,
provider adapters (ASR, alignment, diarisation), VAD and chunk planning, the eval
harness, and a small FastAPI control app for probes.

**Status:** A10 — the three vendor adapters (ElevenLabs Scribe v2, Sarvam Saaras
v4 Batch, AssemblyAI Universal-2), two-signal LID, the routing chain with
fallbacks, the model-backed forced aligners, pyannote community-1 diarisation and
the result cache are all in. Post-processing, glossary correction and transcript
persistence are **A11**; translation and transliteration are **A22**.

**No vendor keys exist yet** (A00-06). Every adapter is tested against recorded
HTTP fixtures, and the manual smoke path for the day the keys arrive is below,
under "Vendor smoke tests".

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

| Route             | Purpose                                                                             |
| ----------------- | ----------------------------------------------------------------------------------- |
| `GET /health`     | liveness; touches neither Redis nor a model                                         |
| `GET /providers`  | every adapter and _why_ it is off; routing, aligners, diarisers, LID backend, cache |
| `GET /metrics`    | Prometheus counters per provider, language and lane (`09 §1`)                       |
| `POST /evals/run` | stub (501); the harness is a CLI                                                    |

## Queues

`worker_ai/queues.py` holds the CONTRACTS §3 queue table verbatim;
`apps/api/src/jobs/contracts/queue-names.test.ts` parses this file, so the two
copies cannot drift.

| Queue                                                 | A09                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.vad`                                              | Silero/energy VAD + the D14 chunk plan                                                                                                            |
| `ai.transcribe`                                       | route → per-chunk ASR → stable word ids                                                                                                           |
| `ai.align`                                            | the D13 aligner registry                                                                                                                          |
| `ai.diarise`                                          | whole-file speaker turns                                                                                                                          |
| `ai.pass`                                             | `passType: "autocut"` (B18, `worker_ai/passes/autocut.py`); any other `passType` (e.g. B19's reframe/zoom) still answers `worker/not_implemented` |
| `ai.translate` `ai.transliterate` `ai.clean` `ai.llm` | consumed, and answered `worker/not_implemented` naming the WP that owns them                                                                      |

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
_verification_ key during a rotation, and a worker is rolled onto a new secret by
restarting it. Delivery is at-least-once and the API is idempotent on
`(jobId, attemptId)`, so a replay answers 200 `applied: false` and that is treated
as success.

**Retries are the subtle part.** A08 gives an `ai.*` job two BullMQ attempts, but
the `jobs` row has a single `attemptId` — so a failed completion posted on the
first attempt moves the row to `failed` and the API rejects the second attempt's
completion as `already_completed`. Hence:

| Failure                    | Completion posted            | Exception re-raised  |
| -------------------------- | ---------------------------- | -------------------- |
| retryable, attempts remain | **no**                       | yes — BullMQ retries |
| retryable, final attempt   | yes, `finalAttempt: true`    | yes — BullMQ fails   |
| non-retryable, any attempt | yes, `error.retryable:false` | yes                  |
| envelope does not parse    | no (there is no `jobId`)     | yes                  |

`finalAttempt` and `error.retryable: false` are the two flags
`markDeadLetterIfFinal` reads, so an exhausted job reaches the DLQ with its last
error attached.

### Locks, stalls and the heartbeat (A08b)

`worker_ai/policies.py` mirrors the policy table of
`apps/api/src/jobs/jobs.config.ts`. `attempts` and `backoff` travel to the worker
inside the BullMQ job options, but `lockDurationMs`, `stalledIntervalMs` and
`maxStalledCount` are `Worker` **constructor** options that each worker package
has to read — so `tests/test_policies.py` parses the TypeScript and fails on any
drift, the same guard the queue names have.

| Queue                         | Lock   | Stall check | Heartbeat |
| ----------------------------- | ------ | ----------- | --------- |
| `ai.transcribe`, `ai.diarise` | 10 min | 60 s        | 200 s     |
| `ai.align`                    | 5 min  | 60 s        | 100 s     |
| every other `ai.*`            | 2 min  | 30 s        | 40 s      |

Every `ai.*` queue gets 2 attempts, 15 s exponential backoff with 0.3 jitter, and
`maxStalledCount: 1` — a job that stalls twice is not unlucky, it is killing its
worker.

**The progress callback is the heartbeat.** A worker that goes quiet for longer
than its lock is declared stalled and its job is handed to a second worker while
the first is still transcribing it — a double charge and a double vendor call. So
`JobContext.heartbeat()` reposts the last known percentage once the interval has
elapsed, `ai.transcribe` beats while a chunk is inside a provider, and
`worker_options()` sets `lockRenewTime` to the same third-of-the-lock cadence so
two consecutive missed beats still leave the lock alive.

## Layout

```
worker_ai/
  __main__.py        one BullMQ Worker per ai.* queue + uvicorn, in one process
  runtime.py         the handler: callbacks, retry semantics, service wiring
  policies.py        the A08b lock/stall/heartbeat table, mirrored from the API
  settings.py        env validation mirroring loadEnv() from @montaj/config
  queues.py          frozen queue names + the pydantic job envelope (CONTRACTS §3)
  callbacks.py       signed progress/completion client
  storage.py         CONTRACTS §6 keys + a narrow boto3 wrapper (derived media)
  audio.py           wav decode, ffmpeg chunk cutting
  vad.py             Silero (ONNX) and energy backends, region post-processing
  chunking.py        the D14 chunk planner
  transcript.py      stable word ids, chunk assembly, the A11 post-process hook
  routing.py         loader, admin overrides, and the fallback chain resolver
  routing.yaml       the v2 routing table of 09 §1 as data
  languages.py       one spelling per language, whatever a vendor calls it
  lid.py             two-signal language identification (D14)
  cache.py           the contentHash + language + provider + model cache (09 §1)
  metrics.py         per-provider, per-language counters for GET /metrics
  logging_setup.py   one JSON line per record, matching the Node workers
  control.py         FastAPI: /health, /providers, /evals/run
  processors/        one module per queue
  providers/         Provider interface, registry, the shared vendor HTTP client,
                     mock, local + serverless Whisper, Scribe v2, Saaras v4, Universal-2
  alignment/         the D13 registry: CTC forced alignment (Indic + XLSR-53), ElevenLabs FA,
                     proportional + VAD, and the script projections they need
  diarisation/       the D13 registry: pyannote community-1, noop, the word join
  evals/             manifest format, WER/CER, runner, CLI, vendor replay
  fixtures/          eval sets, the CC0 speech clip, recorded vendor sessions
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

### The adapter matrix

| Adapter                    | Transcribe | Word timings             | Diarisation                | Alignment              | Languages routed to it                                | Rs/min | Shape                                          |
| -------------------------- | ---------- | ------------------------ | -------------------------- | ---------------------- | ----------------------------------------------------- | ------ | ---------------------------------------------- |
| `elevenlabs` (Scribe v2)   | yes        | **yes**                  | **yes**, up to 32 speakers | yes (Forced Alignment) | hi, en-IN, ta, te, kn, ml, bn, mr, gu, or, ne, as, pa | 0.35   | one multipart request per chunk                |
| `sarvam` (Saaras v4)       | yes        | **no**, chunk-level only | no (pyannote instead)      | no                     | hi-en, ur, sd, kok, ks, sa, sat, mni, brx, mai, doi   | 0.53   | **Batch**: init, upload, start, poll, download |
| `assemblyai` (Universal-2) | yes        | yes                      | yes                        | no                     | en, en-IN, and the global fallback                    | 0.24   | upload, submit, poll                           |
| `serverless-whisper`       | yes        | yes                      | no                         | no                     | any; the global lane (D15)                            | 0.11   | one request per chunk                          |
| `local-whisper`            | yes        | yes                      | no                         | no                     | any; desktop and the `slow` tests                     | 0      | in-process, optional extra                     |
| `mock`                     | yes        | yes                      | no                         | yes                    | any; CI and development                               | 0      | fixture words, no I/O                          |

Bhashini is **not** an adapter and will not become one while its public API is
proof-of-concept-only by its own terms (RR-02 F3, D63). `routing.NEVER_ROUTE`
turns a `routing.yaml` that names it into a load-time error.

### How to add a vendor

1. Write the module under `providers/` against `providers/base.py`, using
   `providers/http.py` for retries, `Retry-After` handling and error mapping.
2. Add its credential to the `unmet` check in `providers/registry.py:build_registry`
   (one `credential(...)` line) and set `implemented=True`.
3. Point a lane at it in `routing.yaml`. Nothing else changes: `routing.resolve_chain`
   walks the lane in order and returns every provider the deployment enables, so
   a vendor that is not configured is skipped with a reason rather than an error.
4. Record HTTP fixtures under `worker_ai/fixtures/vendor/<name>/` and run the eval
   harness against them before changing any weight — `09 §8` blocks a routing
   change on a WER regression over one point.

### Vendor smoke tests (when the keys arrive)

A00-06 signs the DPAs and issues the keys. Until then nothing in this repository
has ever spoken to a vendor: the adapters are driven entirely by recorded
fixtures. The first thing to run on the day the keys land:

```bash
# 1. One chunk through each vendor, against a real clip.
export ELEVENLABS_API_KEY=... SARVAM_API_KEY=... ASSEMBLYAI_API_KEY=...
export RUN_VENDOR_SMOKE=1
python -m pytest tests/test_vendor_smoke.py -v      # skipped without the keys

# 2. The eval harness through each adapter, live rather than replayed.
python -m worker_ai.evals run --set hinglish-mini --provider sarvam
python -m worker_ai.evals run --set hinglish-mini --provider elevenlabs

# 3. GET /providers should report all three enabled; GET /metrics should count them.
curl -s localhost:8091/providers | jq ".providers[] | {name, enabled, reason}"
```

**What to check first**, because the fixtures cannot verify it: the exact field
names in each vendor response (`words[].type` on Scribe, `timestamps.chunks[]` on
Saaras, `words[].start` in _milliseconds_ on AssemblyAI); that the Saaras Batch
storage paths really are Azure blob SAS containers; and that ElevenLabs honours
`enable_logging=false` on the India residency host. Each is called out in its
module docstring, and each is a one-function change if a name differs.

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

## Language identification (D14, `09 §1.1`)

Two signals, and the rule is **agreement**, not confidence — because RR-02 F4
measured IndicLID's romanised head at F1 0.75, which is too weak to put a job on
the dearer code-mix lane by itself.

| Signal   | What it is                                             | Where it comes from                                                                             |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| acoustic | Whisper `detect_language` over 60 s + two 15 s windows | `local-asr` extra, else the D15 model server, else the routed provider's own answer             |
| textual  | a local classifier over the first chunk's text         | IndicLID from `WORKER_AI_INDICLID_DIR`, else a script-share + romanised-Hindi-lexicon heuristic |

- **Code-mix lane** when both signals say Hindi/Hinglish _and_ `codeMixScore ≥ 0.3`
  — or the user hinted Hinglish, which always wins.
- **Agreed language** when both point at the same base tag.
- **The acoustic signal, flagged `lowConfidence`**, when they disagree.

`codeMixScore` is the romanised-Hindi share of the Latin tokens, from a small
closed-class function-word lexicon, so the number is explainable in a support
ticket. Words spelled the same in both languages ("the", "main", "par") count for
neither side.

The whole decision — signals, score, reason — is logged per job and travels in
the completion `result` under `lid`, so "why did this go to Sarvam?" is answerable
from `jobs.result` without a re-run.

**How it costs one chunk, not one extra call.** The first chunk is transcribed on
the provisional lane and _that_ is the acoustic signal; the classifier reads its
text. Only if the two signals move the job to a **different lane** is that chunk
transcribed again — and the discarded call is still recorded as a
`provider_submission` and still counted in `usage.costMinor`, because the vendor
charged for it.

## Models, licences and where their weights live

Nothing here is committed and nothing is downloaded at run time. Every rung
reports itself unavailable, by name, when its directory or credential is absent,
and the chain falls through to something that needs neither.

| Component           | Model                                              | Licence                                                           | Configured by                                    |
| ------------------- | -------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| Diarisation         | `pyannote/speaker-diarization-community-1`         | **CC-BY-4.0** — attribution required, shipped in `engineVersions` | `GPU_PROVIDER_URL` (D15 model server)            |
| Alignment, Indic    | `ai4bharat/indicwav2vec` CTC heads                 | **MIT**                                                           | `WORKER_AI_ALIGN_MODEL_DIR/indicwav2vec/<lang>/` |
| Alignment, global   | `jonatasgrosman/wav2vec2-large-xlsr-53-<language>` | **Apache-2.0**                                                    | `WORKER_AI_ALIGN_MODEL_DIR/xlsr53/<lang>/`       |
| Alignment, remote   | `apps/model-server` `POST /align`                  | MIT / Apache-2.0, per checkpoint the server chose                 | `GPU_PROVIDER_URL` + flag `align.gpu`            |
| Alignment, paid     | ElevenLabs Forced Alignment                        | vendor terms                                                      | `ELEVENLABS_API_KEY` + flag `align.elevenlabs`   |
| Alignment, fallback | proportional + VAD                                 | none needed                                                       | always available                                 |
| LID, acoustic       | faster-whisper                                     | MIT                                                               | optional extra `local-asr`                       |
| LID, textual        | AI4Bharat IndicLID                                 | **MIT**                                                           | `WORKER_AI_INDICLID_DIR`                         |
| VAD                 | Silero v5 (ONNX)                                   | MIT                                                               | `WORKER_AI_VAD_MODEL`                            |

> **Attribution notice.** Speaker diarisation is by pyannote
> `speaker-diarization-community-1` (Hervé Bredin et al.), used under
> [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/). This notice ships in
> the job's `engineVersions.attribution` whenever pyannote ran.

### CTC checkpoint layout

```
$WORKER_AI_ALIGN_MODEL_DIR/
  indicwav2vec/hi/model.onnx      # exported CTC head, float32 [1, N] in
  indicwav2vec/hi/vocab.json      # {"<pad>": 0, "|": 4, "क": 5, ...}
  indicwav2vec/hi/config.json     # optional: {"frameMs": 20}
  xlsr53/fr/model.onnx            # one Apache-2.0 fine-tune per language
```

Roman-script Hinglish is projected onto Devanagari before tokenising (`09 §2`),
by a rule table in `alignment/romanisation.py`, not a model. Nothing is
romanised: every XLSR-53 fine-tune carries its own vocabulary in its own script.

### Meta MMS is excluded (D77)

Rung 3 was `facebook/mms-300m-1130-forced-aligner` until decision **D77**. Its
widely distributed export is **CC-BY-NC-4.0** — non-commercial — so it is
excluded from the product: the module is deleted, not disabled, and `mms` sits in
`routing.NEVER_ROUTE` alongside Bhashini. Naming it in `routing.yaml`, in an
admin routing override, or in the aligner registry raises at load time rather
than at the first job that needs it, because a licence exclusion an operator can
switch back on is not an exclusion.

The replacement splits rung 3 by language family instead of by breadth:
IndicWav2Vec (MIT) for the eleven Indic languages, XLSR-53 (Apache-2.0) for the
global ones, and the proportional + VAD fallback for everything neither covers.

## Caching and cost

A transcription result is cached in Redis under
`contentHash + language + provider + model + mode + chunk span` for **30 days**,
with a per-entry size cap (`WORKER_AI_CACHE_MAX_BYTES`). A hit skips the vendor
call entirely and sets `usage.cached: true` on the completion, so the API does not
count it as a fresh charge. A cache that is down is a _miss_, never a failure.

`GET /metrics` exposes, per provider / language / lane: call counts by outcome,
media seconds, estimated list price in paise, cache hits and misses, and routing
fallbacks. Nothing is ever labelled with a workspace, project or media id — a
metric label is a cardinality bomb and a privacy leak in the same field.

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

## Scripts and translation (A22)

`ai.translate` and `ai.transliterate` are no longer stubs — `worker_ai/transliterate/`
and `worker_ai/translate/` implement them, registered in `runtime.PROCESSORS`
alongside the four A09/A10 queues.

**Transliteration** (`processors/transliterate.py`) is handed `(wid, text)`
pairs directly in the job payload (the producer already read them from
`transcript_chunks`) and a `targetScript` (`roman` or `native`). The default
provider, `RuleTableTransliterationProvider`, is a deterministic dictionary +
syllable-table transliterator (`transliterate/tables.py`) for Hindi/Devanagari
and Tamil — **not** a call to a hosted IndicXlit model: no vendor key or model
weight exists in this environment (A00-06), and IndicXlit is small enough to run
worker-local rather than warranting an `apps/model-server` route with nothing to
serve. `IndicXlitHttpProvider` is the seam for the day a served model exists
(`WORKER_AI_INDICXLIT_URL`). The Hinglish rule — English words stay Roman —
is `transliterate/english.py`: a curated dictionary plus a morphology check
(`-ing`, `-tion`, …), checked before any script mapping runs. The result is
written through `callbacks.write_transcript_scripts` to
`POST /internal/transcripts/{id}/scripts` (A22's own signed surface, not the job
completion payload — see `apps/api/src/transcripts/scripts/README.md`) _before_
the job completes.

**Translation** (`processors/translate.py`) is handed `{segmentId, text}` pairs
and a `baseRevision`, and runs them through `translate/service.py`: glossary
terms are masked to opaque placeholders before any provider sees the text
(`translate/glossary.py` — provider-agnostic, so every adapter gets the
guarantee for free), then the provider chain — `SarvamMayuraProvider` →
`IndicTrans2Provider` (self-hosted, only when `WORKER_AI_INDICTRANS2_URL` is set)
→ `LLMTranslateProvider` (`LLM_PROVIDER=anthropic|openai|mock`) — is tried in
order until one succeeds, and any segment still over the 1.3x length budget
after a "shorter, please" retry is hard-truncated on a word boundary
(`translate/length.py`) so the budget holds unconditionally, not just usually.
The result is submitted as one `SetSegmentText` op per segment (`script:
"translated"`) to the **existing** `POST /internal/projects/{id}/edg/ops`
surface, so a translation is revisioned and undoable exactly like an
interactive edit, and a 409 from a conflicting concurrent edit surfaces as a
clear, non-retryable `worker/translation_conflict` rather than a silent
overwrite or a pointless retry.

LLM prompts are versioned in `translate/providers/prompts.py`
(`TRANSLATE_CAPTION_PROMPT_VERSION`), mirrored (same version string) in
`packages/prompts/src/translate.ts` for the day a TypeScript caller or eval
harness wants the same prompt — the Python copy is the one that actually runs,
because `ai.translate` executes in this worker.

## Evals

```bash
python -m worker_ai.evals list
python -m worker_ai.evals run --set fixtures/hinglish-mini
python -m worker_ai.evals run --set hinglish-mini --json --max-wer 0.15
```

Every adapter can be scored, vendors included — a vendor lane **replays its
recorded session** by default, so the harness runs on a laptop with no keys:

```bash
python -m worker_ai.evals run --set vendor-replay --provider sarvam
python -m worker_ai.evals run --set vendor-replay --provider elevenlabs --json
python -m worker_ai.evals run --set vendor-replay --provider sarvam --live   # A00-06
```

The `vendor-replay` set pairs the CC0 clip in `fixtures/speech-5s` with the
transcript the recorded sessions return, so a corpus WER of 0 means "every
adapter parsed its response correctly" and **nothing at all** about how well any
vendor transcribes Hindi. Quality needs the hand-labelled sets of A00-05.

`--max-wer` exits 1 on a regression, which is the hook `09 §8` needs to block a
routing change. A set is a directory under `fixtures/` with a `manifest.yaml`
(format in `evals/manifest.py`); `audioAvailable: false` says the references are
real and the media has not shipped yet, so a provider that reads audio skips the
set and the mock still exercises the harness. The real sets arrive with **A00-05**.

## Configuration

`docs/CONTRACTS.md` §1 variables are read through `settings.py`, which fails fast
and names every offending variable without ever echoing a value (THREAT-MODEL T21).

These are **deployment naming**, read straight from the process environment and
deliberately _not_ in CONTRACTS §1 — the same precedent the API set for
`MONTAJ_QUEUE_PREFIX` and the OpenTelemetry variables:

| Variable                               | Default                         | Meaning                                                                                                                                               |
| -------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONTAJ_QUEUE_PREFIX`                  | `bull`                          | Redis key prefix; must match the API's                                                                                                                |
| `WORKER_AI_CONCURRENCY`                | `4`                             | jobs in flight per queue                                                                                                                              |
| `WORKER_AI_PORT`                       | `8091`                          | control app port (pod-internal)                                                                                                                       |
| `WORKER_AI_QUEUES`                     | every `ai.*`                    | pin a pool to a subset, e.g. a GPU pool                                                                                                               |
| `WORKER_AI_ROUTING_FILE`               | packaged                        | override `routing.yaml`                                                                                                                               |
| `WORKER_AI_VAD_MODEL`                  | —                               | path to `silero_vad.onnx`                                                                                                                             |
| `WORKER_AI_WHISPER_MODEL`              | `small`                         | faster-whisper model for the local adapter                                                                                                            |
| `WORKER_AI_ALLOW_MOCK`                 | auto                            | force the mock lane on or off                                                                                                                         |
| `WORKER_AI_ALIGN_MODEL_DIR`            | —                               | CTC checkpoints for the D13 aligners (layout below)                                                                                                   |
| `WORKER_AI_INDICLID_DIR`               | —                               | IndicLID heads; without them LID signal 2 is the built-in heuristic                                                                                   |
| `WORKER_AI_CACHE`                      | `redis` when `REDIS_URL` is set | `redis`, `memory` or `none`                                                                                                                           |
| `WORKER_AI_CACHE_MAX_BYTES`            | `524288`                        | largest transcript the cache will store                                                                                                               |
| `WORKER_AI_ROUTING_OVERRIDES_FROM_API` | off                             | fetch admin weights from `GET /internal/routing` (B13)                                                                                                |
| `ROUTING_OVERRIDES_JSON`               | —                               | admin routing weights as JSON, laid over `routing.yaml`                                                                                               |
| `ELEVENLABS_BASE_URL`                  | `https://api.elevenlabs.io`     | India residency: `https://api.in.residency.elevenlabs.io`                                                                                             |
| `ELEVENLABS_ZERO_RETENTION`            | on                              | sends `enable_logging=false` on every request                                                                                                         |
| `SARVAM_BASE_URL`                      | `https://api.sarvam.ai`         | override for a private endpoint                                                                                                                       |
| `ASSEMBLYAI_BASE_URL`                  | `https://api.assemblyai.com`    | override for a private endpoint                                                                                                                       |
| `WORKER_AI_INDICXLIT_URL`              | —                               | A22: a served IndicXlit model; unset runs the rule-table transliterator                                                                               |
| `WORKER_AI_INDICTRANS2_URL`            | —                               | A22: self-hosted IndicTrans2; unset skips it in the translation chain                                                                                 |
| `GPU_PROVIDER_URL`                     | —                               | serverless GPU endpoint (D15); also serves `/diarise` and `/detect-language`                                                                          |
| `GPU_PROVIDER_TOKEN`                   | —                               | bearer token for it                                                                                                                                   |
| `FFMPEG_BIN` `FFPROBE_BIN`             | on `PATH`                       | explicit binary paths                                                                                                                                 |
| `PASS_FACE_DETECTOR`                   | unset (`BrightBlobDetector`)    | B19b: `yunet` selects a real face detector for `zoom`/`reframe` frame sampling; unimplemented this WP (needs `PASS_FACE_DETECTOR_WEIGHTS` too — H-22) |
| `PASS_FACE_DETECTOR_WEIGHTS`           | —                               | B19b: weights path for the above, provisioned at image build, not a repo checkout                                                                     |

`GPU_PROVIDER_URL` is a **raise for the orchestrator**: CONTRACTS §1 freezes
`GPU_PROVIDER` but not its endpoint, and A09 may not edit that file. It is
documented here until §1 gains it.

Provider enablement is `credential present` AND `feature flag not off`. Flags come
from `FEATURE_FLAGS_JSON` and are named `asr.<provider>`; the two non-ASR stages
have flags too, `align.elevenlabs` (the paid aligner) and `diarise.pyannote`.

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
That is the image this work package's code runs in: **this worker is the client
of the GPU model server, never the server.**

The server itself is **`apps/model-server`** (A26) — its own app, its own image
(`apps/model-server/Dockerfile`), its own weight bake
(`apps/model-server/scripts/bake_models.py`). `apps/worker-ai/Dockerfile.gpu` was
a placeholder describing that image before it existed and has been **deleted**:
two files describing one image is how they drift.

Four routes on it are called from here, each with a client and a recorded
response in `fixtures/vendor/gpu-whisper/session.json`:

| Route                   | Client                             |
| ----------------------- | ---------------------------------- |
| `POST /transcribe`      | `providers/serverless_whisper.py`  |
| `POST /align`           | `alignment/gpu.py`                 |
| `POST /diarise`         | `diarisation/pyannote.py`          |
| `POST /detect-language` | `lid.py` (`GpuLanguageIdentifier`) |

That recording is the contract in both directions: A26's
`tests/test_contract_fixtures.py` asserts its live responses are a superset of
the same file, so neither app can change the shape without the other's tests
failing.

## Quality gates

| Command                                     | Gate                                                     |
| ------------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @montaj/worker-ai lint`      | ruff (pyflakes, isort, bugbear, bandit, annotations)     |
| `pnpm --filter @montaj/worker-ai typecheck` | `mypy --strict`                                          |
| `pnpm --filter @montaj/worker-ai test`      | pytest + hypothesis, with the CONTRACTS §9 coverage gate |

Two markers gate the slow paths: `slow` (a real model download; `RUN_SLOW=1`) and
`integration` (the compose stack and a running API; `RUN_INTEGRATION=1`). See
`tests/test_integration.py` for what the integration run needs.

`tests/test_queues.py` and `tests/test_settings.py` parse the TypeScript sources
directly, so the Python queue names and env contract cannot drift from the Node
side without failing CI.
