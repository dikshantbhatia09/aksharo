# apps/engine — the local sidecar (`montaj-engine`)

The desktop app's on-device transcription/VAD/denoise/render sidecar (brief
C03a): a Node supervisor exposing a localhost-only HTTP/WS contract, backed
by whisper.cpp, Silero VAD, `deep-filter` and ffmpeg — none of which are ever
compiled or committed to this repo. Every binary and model weight comes from
a versioned, SHA-256-verified manifest fetched from `MODEL_WEIGHTS_BASE_URL`
(the "H-22" pattern already used by `packages/fonts`).

**Status:** the HTTP/WS contract, model manager, backend/tier detection and a
deterministic `FakeBackend` are implemented and fully tested here (C03a). The
local quality-gate harness and tiered latency benchmarks (`bench/**`) are
**C03b**'s, proven end to end against `FakeBackend` in this repo; the real
whisper.cpp/Silero/deep-filter backends (spawning and talking to the native
processes on real hardware) are **A00-10**'s, behind the same `EngineBackend`
interface (`src/backends/types.ts`) — see "Quality gate and latency
benchmarks" and "Open questions" below.

## Contract

Every route except `/health` requires `Authorization: Bearer <token>` (the
token from the discovery file, see below) and a `Host` header of
`127.0.0.1:<port>` or `localhost:<port>`.

| Route              | Method | Auth                                     | Notes                                                  |
| ------------------ | ------ | ---------------------------------------- | ------------------------------------------------------ |
| `/health`          | GET    | no                                       | backend, tier, engine versions, `modelsMissing`        |
| `/models`          | GET    | yes                                      | installed/available/downloading, disk usage            |
| `/models/download` | POST   | yes                                      | `{ modelId }`                                          |
| `/models/delete`   | POST   | yes                                      | `{ modelId }`                                          |
| `/transcribe`      | POST   | yes                                      | mirrors `apps/model-server`'s `/transcribe` word shape |
| `/transcribe` (WS) | —      | yes (bearer as a `?bearer=` query param) | streams `partial`/`done`/`error` frames                |
| `/align`           | POST   | yes                                      | mirrors `apps/model-server`'s `/align` word shape      |
| `/clean`           | POST   | yes                                      | `deep-filter`, 48 kHz                                  |
| `/render`          | POST   | yes                                      | delegates to `@montaj/render-skia-node`                |

Every response and request is validated against the Zod schemas in
`@montaj/engine-client` (`packages/engine-client`), which both `apps/desktop`
and `apps/web` import — one parser, not two that can drift.

## Backend detection and latency tiers

`src/detection.ts` computes a backend (`metal-coreml` | `vulkan` | `cuda` |
`cpu`) and a latency tier (A–D) from an injected `SystemInfo`, per
`03-architecture/05-system-architecture.md` §7:

| Tier | Condition                                  | Note                                                            |
| ---- | ------------------------------------------ | --------------------------------------------------------------- |
| A    | Apple Silicon, ≥16 GB RAM                  | Metal + CoreML encoder when the CoreML model is installed       |
| B    | Windows, ≥8 cores, ≥16 GB RAM, GPU present | Vulkan default, CUDA pack when both a device and the pack exist |
| C    | 4-8 cores, ≥8 GB RAM                       | small model                                                     |
| D    | <8 GB RAM, or below the C floor            | local engine disabled — cloud with a banner                     |

## Model manifest

`src/manifest.ts#defaultManifest()` lists the default ASR model
(`ggml-large-v3-turbo-q5_0`, 574 MB), the `small`-fallback ASR model
(`ggml-small-q5_1`, 190 MB), a CoreML encoder variant (macOS only), Silero
VAD, `deep-filter`, and ffmpeg — each with a SHA-256 (placeholders in this
repo; a real manifest is published to `MODEL_WEIGHTS_BASE_URL`). `ModelManager`
(`src/model-manager.ts`) downloads with resumable `Range` requests, verifies
the hash before an atomic rename into place, enforces a disk budget, supports
delete, and re-verifies every installed file's hash on launch (THREAT-MODEL
T22 — a tampered file is never trusted just because it is present).

## Discovery file and security (T22)

On start, the engine binds an ephemeral port on `127.0.0.1` and writes
`~/.aksharo/engine.json` (mode `0600`): `{ port, bearer, pid, version,
startedAt }`. This is a separate file from the bridge's own `bridge.json`
(`packages/bridge-core`) — the engine and the bridge are independent sidecars
with independent lifetimes. Bearer comparison, Host validation and rate
limiting reuse `@montaj/bridge-core`'s `security.ts` exports rather than a
second implementation.

## FakeBackend

`src/backends/fake-backend.ts` answers every route deterministically from
`src/fixtures/sample-transcripts.json`, matched by a substring in the
request's `audio` field (falling back to a default fixture). This is what
every test in this WP runs against — no whisper.cpp/Silero/deep-filter
binary is ever downloaded into this sandbox.

## Quality gate and latency benchmarks (C03b)

`bench/**` (`pnpm --filter @montaj/engine bench`) is the local quality-gate
harness: for each model (`turbo-q5_0`, `small`) it calls `/transcribe` +
`/align` through `@montaj/engine-client` — exactly the path `apps/desktop`
uses — against the committed Hinglish reference set
(`fixtures/hinglish-reference.json`: A23's 90s sample plus D08's
`hinglish-mini` eval-set references, scored against a committed cloud-aligner
snapshot standing in for A10's CTC/xlsr aligner), computes WER/CER via a thin
call into D08's own metrics (`apps/worker-ai/worker_ai/evals/local_engine.py`,
reusing `worker_ai.evals.metrics` rather than a second implementation), checks
the median word-boundary error against the 80ms bar
(`03-architecture/05-system-architecture.md` §7), checks wall-clock latency
against the per-tier bars (A/B/C; D is local-disabled), cross-checks the
harness's own tier detection against the server's `/health` tier, and writes
a dated report to `docs/verification/local-engine-<profile>-<date>.md`+`.json`.

**Here, this always runs against `FakeBackend`** (this repo's "Reality":
no real ASR/aligner binary exists in this sandbox), so the report's gate is
`skipped-fake-backend` — plumbing, threshold math and report format proven,
never a real pass/fail. The same command, unchanged, runs against a real
`EngineBackend` on a Gate C machine once one exists behind `src/backends/
types.ts`'s seam — see `docs/GATE-C-CHECKLIST.md`'s "Local engine quality
gate" section for the exact procedure and where results get pasted.
`.github/workflows/local-engine-bench.yml` runs the `FakeBackend` job on every
push/PR that touches this package so the harness itself never rots; the real
job is `workflow_dispatch`-only until a real-hardware runner exists.

## Open questions for A00-10

- Real backend wiring (spawning whisper.cpp/Silero/deep-filter/ffmpeg,
  talking to them over their own IPC, translating to this contract) is not
  implemented — `EngineBackend` is the seam a real backend implements
  against, exercised end to end by C03b's `bench/**` harness above once one
  exists.
- `detection.ts`'s CUDA/Vulkan probing (`nvidia-smi`, driver detection) is not
  implemented here — `SystemInfo` is an injected interface so `main.ts`'s real
  probe is a small, separately testable addition A00-10 can make without
  touching the tier logic.
