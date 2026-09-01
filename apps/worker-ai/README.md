# @montaj/worker-ai

Python 3.12 worker: the **official BullMQ Python** consumer, provider adapters
(ASR, alignment, diarisation), VAD, passes, LLM calls and the eval harness, plus a
small FastAPI control app for probes.

**Status:** A01 scaffold — consumes `ai.transcribe` with a stub processor and
defines the `Provider` interface. The real worker lands in **A09** and **A10**.

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

On a healthy boot:

```json
{
  "level": "info",
  "service": "worker-ai",
  "msg": "worker-ai ready — waiting for jobs on ai.transcribe"
}
```

The FastAPI control app answers `GET /health` on `WORKER_AI_PORT` (default 8091)
and is **pod-internal** — never expose it publicly. `WORKER_AI_CONCURRENCY`
(default 4) caps parallel jobs.

## Dependencies

`pyproject.toml` holds the direct, exactly-pinned dependencies;
`requirements.lock` (runtime) and `requirements-dev.lock` (runtime + dev) are
pip-tools output and are what actually gets installed. After editing
`pyproject.toml`:

```bash
pnpm --filter @montaj/worker-ai lock
```

`bullmq` is pinned per `docs/CONTRACTS.md` section 3. Features the Python client
does not support — flow producers, repeatable jobs, sandboxed processors — are
documented there as **not used**, so the Node producers must not rely on them.

## Layout

```
worker_ai/
  __main__.py        BullMQ worker + uvicorn control app in one process
  settings.py        env validation mirroring loadEnv() from @montaj/config
  queues.py          frozen queue names + job envelope (CONTRACTS section 3)
  logging_setup.py   one JSON line per record, matching the Node workers
  control.py         FastAPI app: GET /health
  processors/        one module per queue (ai.transcribe today)
  providers/base.py  abstract Provider: transcribe / align / diarise
tests/               pytest + hypothesis
```

## The Provider interface

`providers/base.py` defines signatures only. It encodes the rules every adapter
must follow: word ids are allocated by the caller and never reused, times are
milliseconds, providers never touch storage or the database, and errors declare
whether they are retryable. A09 adds the mock and serverless faster-whisper
adapters; A10 adds ElevenLabs Scribe v2, Sarvam Saaras v4 and AssemblyAI plus
routing weights.

Transcript text reaching an LLM is always wrapped in a delimited data block and
never executed as an instruction (THREAT-MODEL T19).

## Quality gates

| Command                                     | Gate                                                 |
| ------------------------------------------- | ---------------------------------------------------- |
| `pnpm --filter @montaj/worker-ai lint`      | ruff (pyflakes, isort, bugbear, bandit, annotations) |
| `pnpm --filter @montaj/worker-ai typecheck` | `mypy --strict`                                      |
| `pnpm --filter @montaj/worker-ai test`      | pytest + hypothesis                                  |

`tests/test_queues.py` and `tests/test_settings.py` parse the TypeScript sources
directly, so the Python queue names and env contract cannot drift from the Node
side without failing CI.
