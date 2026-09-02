# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are grouped by work package id (see `docs/PLAN.md`).

## [Unreleased]

### Fixed

- **A16e — the CanvasKit backdrop blur is clipped to its bounds.** Reported by A20.
  `render-core` documents a `backdrop` blur as blurring what is already on the surface
  **inside `bounds`**, and `@montaj/render-skia-node` clips to honour that. The browser
  executor passed the bounds to `saveLayer` and stopped there — but Skia treats
  `SaveLayerRec`'s bounds as a hint about how much surface the layer needs, not as a
  boundary on what the filter may touch, so it softened a sigma-wide band right across
  the frame. Over real footage that is the difference between a frosted caption panel
  and a fogged video. `executeCommands` now issues a `clipRect` before the layer.
  - Every committed baseline used a **flat** ground, on which blurring outside the panel
    changes nothing, which is why A16's own suite never saw it. The new
    `liquid-glass-hard-edge` baseline lays a hard edge through the panel: inside it must
    be blurred, outside it must stay razor hard, so a filter that does nothing and a
    filter that fogs the frame both fail. `BaselineFrame` gained an optional `ground`
    for this. Removing the clip moves 5,280 pixels and fails three assertions.
  - `render-skia-node`'s parity suite asserted the divergence on purpose
    (`outsideDiffering > 0`, "if `render-canvaskit` is fixed, this drops to zero"); it now
    asserts `0`, and the two backends agree inside **and** outside the panel. Affected
    baselines and the `liquid-glass` catalogue preview regenerated; the browser lane holds
    at 0 pixels differing on all eight frames.

### Added

- **A11 — api: transcripts, post-processing, segmentation and the EDG hand-off.**
  - **The worker stays stateless.** `ai.transcribe` completions carry
    `result.chunks` already shaped like `transcript_chunks` (A09's
    `processors/transcribe.py::_result`), and everything that turns them into a
    project happens in one place: `TranscribeCompletionHandler`.
  - **A per-job-type completion handler registry** in `apps/api/src/jobs/completion-handlers.ts`.
    A08 owns the state machine — the conditional `UPDATE`, the settlement, the
    dead letter, the realtime echo — and it is the same for every queue; what a
    completion _means_ is not, so a queue's owner registers a handler at boot and
    `jobs` never learns what a transcript is. Exactly one handler per queue; a
    second is a boot-time error.
  - **The handler runs before the status flip**, so a throw leaves the job
    `running` and the worker's at-least-once retry re-drives it. The alternative
    would make the first transient database error permanent, because the replay
    would be answered `already_completed` before the handler was reached. Every
    write is therefore idempotent: an upsert on the **producer-minted**
    `transcriptId` that travels in the job payload, a delete-and-rewrite of the
    revision's chunks and of the job's provider submissions, and A12's
    `EdgService.initialise`, which is idempotent by project.
  - **One transaction** for `transcripts` + `transcript_chunks` +
    `provider_submissions` + the project's language and scripts. The EDG document
    is deliberately outside it — A12's repository opens its own and Prisma cannot
    nest one — in the safe order: the transcript exists before anything points at
    it, and both halves converge on a retry.
  - **Post-processing (`09 §3`)**, pure and table-tested across Roman Hinglish,
    Devanagari and Tamil: ASR timings rounded to **integer milliseconds** at the
    trust boundary and clamped into their chunk; speaker labels renumbered `s1…`
    by first appearance in the media; **two-signal LID** (D14) combining the
    provider's answer with the script the words are actually written in, so
    Hindi in Roman letters is `hi-Latn` and both signals are stored;
    punctuation from pauses ≥ 600 ms with a danda for Devanagari and capitals
    only where a script has them; Indian numeral grouping (`ek lakh bees hazaar`
    → `1,20,000`, `rupaye pachaas` → `₹50`) that refuses any run which does not
    read as a number; glossary and remembered-spelling correction on a phonetic
    key plus edit distance ≤ 2; and filler tagging from `fillers.json`, where a
    contextual entry such as `toh` is tagged only when a pause brackets it.
  - **The consent gate is the query.** `MemoryGlossarySource` reads
    `memory_entries` only while the memory consent record is granted and
    un-withdrawn and the entry is unexpired — there is no boolean a caller can
    forget to pass. B09 writes those entries; A11 reads them.
  - **Every change is logged.** Each step reports `{step, wordId, before, after,
reason}`; the log is written to `job_events` as `transcript.postprocessed`
    and returned by `GET /projects/{id}/transcript` as `postProcessing`.
  - **Caption budgets (D78).** `maxChars = min(readability cap, fit cap,
workspace preference)`, resolved per script from the project's canvas in
    `src/edg/init/caption-budgets.ts` and recorded on
    `EdgHot.meta.engineVersions.captionBudgets` so A15 can offer "Reflow
    captions". The fit half calls A16d's `fitBudget` for real; it needs a font
    registry and a shaper, which **A18b** registers, so until something binds
    `CAPTION_RENDER_CONTEXT` the budget is the readability cap and says so
    (`source: "readability"`). The call is covered through
    `@montaj/render-core/testing`'s fixture renderer, so binding a registry is
    the only change left. Landscape footage overrides an _untouched_ 9:16
    default; a chosen aspect is never second-guessed.
  - **Endpoints**, all behind `WorkspaceMemberGuard` with roles, and a project in
    another workspace is a 404 (THREAT-MODEL T4, T5):
    `POST /projects/{id}/transcribe` (quotes from the probed duration at 1 credit
    a media minute, reserves, enqueues), `GET /projects/{id}/transcript` (paged
    chunks), `GET /projects/{id}/transcript/export?format=json|srt|vtt|txt`
    (**source time**; output-time exports are A21's), and
    `POST /projects/{id}/transcript/retranscribe`, refused with
    `transcript/has_edits` once the captions have been edited unless `force`.
  - **The `/internal` JSON body limit is 32 MB** (`internal-body-limit.ts`),
    because a 60-minute transcript is megabytes of words — with a test that posts
    one. `/internal` only: that surface needs `INTERNAL_CALLBACK_SECRET`, and
    raising the limit globally would let any anonymous request tie up 32 MB.
  - **Widow rebalancing in `@montaj/edg`'s segmenter.** A forced break must not
    leave one word alone in a caption when the caption before it can give up its
    last word and both halves still fit; a speaker change and a full stop are
    left alone, because a one-word caption after a full stop is the speaker's.
    Goldens regenerated (`pnpm --filter @montaj/edg golden:build`).

- **A10c — the model-server alignment rung, and the stale-reference sweep after A26.**
  - `worker_ai/alignment/gpu.py`: `GpuCtcAligner`, `POST /align` on
    `apps/model-server`. It sits at rank 35 — **below** the two local CTC rungs,
    which cost only the CPU pod they already run in, and **above** the paid
    ElevenLabs one. The `ai.*` pool is the CPU pool and carries no weights, so on
    a normal deployment this is the rung that actually runs: the chain becomes
    model server, then paid, then proportional.
  - Three facts from A26's response shape the adapter, and each is pinned by a
    test: words come back in **file time** (the server adds `startS` itself, so
    only the caller's `offset_ms` is applied); there is always **one word per
    input word**, a word outside the checkpoint's vocabulary getting
    `probability: 0.0` and a mention in `skipped[]` rather than being dropped;
    and `licence` is per checkpoint, so which family answered is recorded.
  - `fixtures/vendor/gpu-whisper/session.json` gained a **real** `/align`
    response, produced by driving `apps/model-server`'s own test client rather
    than hand-written from prose. A26's `tests/test_contract_fixtures.py` reads
    the same file from the other side, so neither app can change the shape
    without the other's tests failing. `fixtures/vendor/gpu-align-skipped/`
    records the degraded case.
  - **`apps/worker-ai/Dockerfile.gpu` is deleted.** It described the GPU image
    before that image existed; `apps/model-server/Dockerfile` is the real one, and
    two files describing one image is how they drift. The README's GPU section now
    names `apps/model-server` and tables the four routes this worker calls with
    their clients, and `alignment/xlsr.py` cites
    `apps/model-server/scripts/bake_models.py --aligner-global` instead of X05's
    removed `infra/gpu/runpod/bake_models.py`.

- **A26 — model-server: the GPU model server (`apps/model-server`), serving
  `/transcribe`, `/align`, `/diarise` and `/detect-language` for the serverless
  GPU lane (D15), with dynamic batching, warm-model lifecycle, a memory guard,
  cost accounting, and RunPod/Modal packaging.**
  - **The wire contract is the worker's, not this app's.** `apps/worker-ai`
    already had three clients written against a server that did not exist
    (`providers/serverless_whisper.py`, `diarisation/pyannote.py`, `lid.py`), and
    A10 recorded their exchanges in
    `worker_ai/fixtures/vendor/gpu-whisper/session.json`.
    `tests/test_contract_fixtures.py` asserts every live response is a **superset
    with matching types** of that recording, and `tests/test_worker_adapter.py`
    drives the worker's own three clients over a real socket against a real
    uvicorn — the only test that fails when the two apps disagree. Times on the
    wire stay **seconds** everywhere except `/detect-language`'s `windows`, which
    is milliseconds because `lid.py` already sends it that way.
  - **Dynamic batching for `/transcribe`** (`model_server/batching.py`): up to
    `MODEL_SERVER_BATCH_MAX_SIZE` chunks inside a 50 ms window, handed to the ASR
    backend as one call. Decision **D74** makes this load-bearing rather than an
    optimisation — X05's re-derivation gives ₹0.19 per media minute without
    batching against the ₹0.09–0.13 band in `05 §12` — so
    `model_server_batch_size` measures what actually happened and
    `usage.gpuSeconds` is the group's wall clock **divided by `batchSize`**, with
    `batchSize` on the wire so the division can be audited. Charging each request
    the whole group would inflate COGS per credit by exactly the batching factor.
  - **Models load once, at startup, from the baked image.** No request ever
    triggers a load. `MODEL_SERVER_PRELOAD` selects which backends are
    instantiated at all, so a CPU worker that only transcribes never pages
    pyannote into memory. A backend that fails to load does **not** take the
    process down: it is recorded, `model_server_model_ready` stays at 0, its
    routes answer 503 with the reason, and the others keep serving — on a
    serverless worker a hard exit is a crash loop that still bills. SIGTERM flips
    readiness **before** uvicorn winds down, so a load balancer stops sending work
    to a worker that is about to stop.
  - **A memory guard, not a CUDA OOM.** A request reserves an estimate before the
    model call and is refused with `503` + `Retry-After` when it does not fit; the
    worker's HTTP client already retries 5xx and already obeys the header, so a
    refusal costs a wait rather than a job.
  - **Decision D77 is enforced, not merely documented.** IndicWav2Vec (MIT) for
    Indic languages and XLSR-53 CTC fine-tunes (Apache-2.0) for global ones;
    **MMS never** — `scripts/bake_models.py` fails the image build if any
    argument names an MMS checkpoint, so the CC-BY-NC-4.0 problem cannot be
    reintroduced by a `--build-arg`. pyannote community-1's CC-BY-4.0 attribution
    is surfaced in `engineVersions` on every diarised response, byte-identical to
    the worker's constant, with a test that asserts they match.
  - **Script projection stays in the caller.** `/align` tokenises the words it is
    given against the checkpoint's vocabulary and reports what it could not
    represent in `skipped`; the Devanagari projection for Roman-script Hinglish
    (`09 §2`) lives in `worker_ai/alignment/romanisation.py` with IndicXlit
    behind it as A22's work, and a second, disagreeing table here would be worse
    than none.
  - **Auth is a boot condition.** `GPU_PROVIDER_TOKEN` is compared in constant
    time on all four routes, ahead of body validation so a 401 never reveals which
    fields were wrong; with the token empty the process **refuses to start**
    unless `MODEL_SERVER_ALLOW_ANONYMOUS=1` says a human meant it. `/healthz`,
    `/readyz` and `/metrics` are unauthenticated and carry no user data. Logs are
    JSON with a redaction chokepoint: no audio, no transcript text, no credential,
    and presigned URLs reduced to scheme, host and path (THREAT-MODEL T21).
  - **Packaging** replaces X05's placeholders, which pointed at
    `apps/worker-ai/requirements-gpu.lock` and a `montaj_worker_ai.gpu` package
    that never existed. `apps/model-server/Dockerfile` is multi-stage: a `cpu`
    target CI builds and boots with no GPU, no weights and no Hugging Face token,
    and a CUDA `runtime` target that bakes every weight and runs offline.
    `scripts/bake_models.py` is the single bake step both providers run and also
    exports the CTC heads to ONNX in the layout `worker_ai/alignment/ctc.py`
    reads. `model_server/runpod_handler.py` serves RunPod's queue API from the
    **same** app, batcher and warm models. `infra/gpu/runpod/endpoint.json` and
    `infra/gpu/COST.md` are X05's and stay; `infra/gpu/runpod/Dockerfile` and
    `infra/gpu/runpod/bake_models.py` are deleted rather than left as a second,
    wrong source of truth.
  - **Cost accounting** (`apps/model-server/cost.md`): `usage {gpuSeconds,
audioSeconds, model, batchSize}` on every response, the arithmetic behind it,
    the measured CPU-`tiny` numbers, and the empty table the first real GPU run
    fills in. The honest CPU finding, carried up into `infra/gpu/COST.md`: **on
    CPU, batching costs rather than saves** (batched RTF 1.4–1.8 against
    serial 0.95–1.6), because CTranslate2 already uses every core. That says
    nothing about a GPU, where a single stream leaves the card idle — but it
    does mean the CPU lane should run `MODEL_SERVER_BATCH_MAX_SIZE=1`.
  - **Metrics** `model_server_*` registered in `infra/observability/METRICS.md`
    §11 **before** the code, per D75. They are the only names in that file
    without the `montaj.` prefix, because a RunPod or Modal sandbox has no OTel
    collector beside it and this process is scraped directly in native Prometheus
    form.
  - 199 tests, `ruff`, `ruff format --check` and `mypy --strict` clean;
    coverage **95.3 % lines / 88.4 % branches** against the CONTRACTS §9 gate
    of 75/70, checked by `scripts/coverage_gate.py` because `--cov-fail-under`
    blends the two into one number that can pass while the contract fails.
- **A20b — the rasteriser moves to worker threads, and `pnpm format:changed`.**
  - Skia now runs on `min(cores − 1, 4)` worker threads
    (`apps/render/src/render/pool.ts`), so it overlaps with ffmpeg instead of taking
    turns with it: **1080p goes from 1.13× to 2.31× realtime**, and the whole render
    (12.97 s for 30 s of output) now costs about what the encoder alone costs (13.22 s),
    which is the ceiling this architecture has. 540p is 4.87×, 4K 0.45×.
  - Frames never cross the thread boundary: each slot is a `SharedArrayBuffer` the main
    thread allocates once and a worker draws into in place (`FrameOptions.into` on
    `@montaj/render-skia-node`'s batch). Only the finished `DrawCommand[]` is sent, about
    12 KB. Memory is `slots × width × height × 4` with `slots = workers × 2` — 66 MB at
    1080p, 265 MB at 4K — whatever the length of the video.
  - Layout, the frame-diff hash and the cache decision stay on the main thread, so the
    cache is exactly as exact as it was single-threaded and two thirds of a render never
    reach a worker. A slot is released only when `stream.write`'s completion callback
    fires, reference-counted per frame, which is what stops a slot being redrawn
    underneath a caption still queued in the pipe.
  - `src/render/pool.test.ts` renders every frame both ways and asserts the bytes are
    **identical** — which is how a missing watermark was caught: each worker has its own
    Skia and its own image table, and nothing had put the mark in it. The nineteen-frame
    parity table is unchanged to four decimal places.
  - `RENDER_RASTER_WORKERS` sizes the pool; `0`, a machine without worker threads, or an
    image missing `workers/raster-worker.mjs` all fall back to rasterising inline, with a
    warning and the same pixels.
  - **`pnpm format:changed`** (and `format:changed:check`) runs Prettier over what the
    branch actually changed — the merge base with `main`, plus the working tree — instead
    of the whole repository. Every work package so far has had to hand-revert a
    `pnpm format` run over files it never touched; the root `README.md` now says to use
    this one.

- **A06 — api: projects, folders, media ingest, derived URLs, subtitle import and
  retention.**
  - `apps/api/src/common/storage/`: an `ObjectStore` port with two instances —
    `RAW_STORE` (`S3_BUCKET_RAW`, AWS S3 `ap-south-1` in production) and
    `DERIVED_STORE` (`R2_BUCKET_DERIVED`, Cloudflare R2), both MinIO locally.
    Presigned multipart PUT, presigned GET with a five-minute TTL, HEAD, delete
    and object tagging over the AWS SDK v3. `storage.keys.ts` is the TypeScript
    twin of `apps/worker-ai/worker_ai/storage.py` and refuses to build a
    CONTRACTS section 6 key from anything that is not a ULID (THREAT-MODEL T5).
  - **The bytes never pass through the API.** `POST /projects/{id}/media/init`
    checks the plan cap and returns one presigned URL per 16 MiB part;
    `POST /media/{mediaId}/complete` closes the multipart upload, records the
    store's own byte count, sets `raw_purge_at` (upload + 7 days) and
    `derived_purge_at` (the plan's retention), and enqueues `media.probe` then
    `media.proxy`. Both are deduplicated on `jobKey`, so a retried completion
    returns the same two job ids rather than four jobs.
  - `POST /projects/{id}/media/{mediaId}/replace` puts new bytes on the **same**
    media row — transcripts, the EDG document and exports all reference that id —
    clears everything that described the old bytes and sets `needs_realign`.
  - `GET /projects/{id}/media/{mediaId}/urls` signs only the derived artefacts
    that exist, so the response doubles as "what is ready".
  - `POST /projects/{id}/import` and `/import-url` parse SRT, WebVTT, ASS and
    plain text into one normalised cue list (BOM and CRLF handled, ASS override
    tags stripped, Devanagari untouched), store it as a JSON sidecar under the
    media prefix as a `media_assets` row with role `subtitle`, and enqueue
    `ai.align`. Plain text is marked untimed, which is the signal alignment needs.
  - `apps/api/src/common/net/safe-fetch.ts`: the egress-restricted client of
    THREAT-MODEL **T6** — http(s) on ports 80/443 only, every resolved address
    judged against a deny list (RFC1918, loopback, link-local including
    `169.254.169.254`, CGNAT, IPv6 ULA, multicast, IPv4-mapped and NAT64), the
    vetted address **pinned** for the connection, three redirects, 2 MB and ten
    seconds. A refusal reaches the caller as `import/blocked_url` with no detail.
  - `RetentionService.purgeDueMedia()` (D47): two independent clocks, raw at seven
    days and derived at the plan's retention. The object is deleted before the row
    is marked, so a crash leaves a retryable sweep rather than stranded storage.
    It registers no schedule — B16 owns that wiring.
  - `POST /projects/batch` creates up to 50 projects in one transaction; folders
    are a real table with cycle and depth checks and an "empty before delete" rule.
  - Every `/projects`, `/folders` and `/media` route wears `JwtAuthGuard`,
    `WorkspaceMemberGuard` and `RolesGuard`. Another tenant's id is a **404**, never
    a 403 (T5).
  - Media types are an allow-list (T7): `application/octet-stream` is accepted only
    when the filename's extension is one we know, and the extension that reaches a
    key is chosen from the same lists, never from the filename directly.

- **A20 — the cloud render service: `apps/render`, `@montaj/render-skia-node`,
  `@montaj/render-manifest`.**
  - `@montaj/render-skia-node` is implemented: the same `DrawCommand[]` the browser
    executes, run against Skia's native build (`@napi-rs/canvas` 1.0.8, pinned), with
    `outlineTextCommands` converting every glyph run to a path because Canvas2D has no
    glyph-id entry point. No system font is ever consulted (D33). Frames come out as
    straight RGBA through a reusable batch buffer — a 1080×1920 frame is 8.3 MB and a
    ninety-second Reel is 2,700 of them.
  - **Parity against CanvasKit is measured, not asserted.** Nineteen frames — A16's
    seven baselines plus the four caption fixtures at three instants — of which sixteen
    are inside decision D33's SLO (≤ 1% of pixels off by more than 2/255) and the mean
    is 0.83%. Everything except text is bit-exact; the residual is Skia's glyph cache
    against an analytic path fill, and it grows as the type gets smaller.
    `neon-glow-english` (3.31%) and the two entry-instant frames (1.10% and 1.20%) are
    over, pinned with their measured values and their reason. Four conversions with a
    unit in them — blur sigma, shadow sigma, the miter limit and layer opacity — are
    asserted on their own so a regression names the conversion rather than a whole
    frame.
  - `@montaj/render-manifest` defines the server-signed `RenderManifest` of `05 §5.2`:
    project and EDG revision, style-catalogue snapshot ids, timemap edits, aspect,
    resolution and fps, the watermark decision, the plan's caps, the audio strategy and
    the subtitle request. Signed with `INTERNAL_CALLBACK_SECRET` over canonical JSON
    under a domain-separation prefix, verified against `INTERNAL_CALLBACK_SECRET_NEXT`
    too, so one rotation procedure covers manifests and callbacks and no new secret was
    added. Five refusals with stable codes: malformed, bad signature, expired, not yet
    valid, caps exceeded.
  - `apps/render` consumes `render.video` and `render.subtitle`. A render verifies the
    manifest, builds the timemap (D30), and checks the caps against the _rendered_
    length — all **before a byte of media moves** — then downloads the source, probes
    it, draws frames on Skia and pipes them into ffmpeg as a second `rawvideo` input.
    Cuts become `trim`/`concat` per retained span so video and audio are cut at the same
    instants; the base is forced to the output frame rate immediately before `overlay`
    so the two streams stay frame-aligned; presets get a centre cover `scale`/`crop`.
    x264 `veryfast` at CRF 20 (1080p) / 18 (4K) with `+faststart`, or ProRes 4444 /
    VP9-alpha for an alpha export and a solid chroma ground for green-screen. Output to
    R2 under CONTRACTS §6, with `usage.outputSeconds` and `egressBytes: 0` (D35).
  - **The watermark decision is the server's** (THREAT-MODEL T10): it travels inside the
    signature, is drawn from the manifest rather than the projection, and stripping it
    from a signed document is a `manifest/bad-signature` refusal — tested with that
    exact attack.
  - A frame cache keyed on `hashCommands` reuses the previous frame's pixels whenever
    the command list is unchanged: two thirds of the frames of the sample project at
    1080p, four fifths at 4K. It is exact rather than heuristic, because outlining is a
    pure function of the hashed list.
  - `render.subtitle` writes SRT, VTT, TXT and Markdown, one file per (format × script),
    with every cue remapped onto the output clock and a segment straddling a splice
    split into two cues. ASS is refused with a message naming A18a.
  - The signed callback client is a TypeScript mirror of
    `apps/worker-ai/worker_ai/callbacks.py`, down to the header names and the rule that
    the bytes signed are the bytes sent; the A08b retry, stall and heartbeat table is
    mirrored with a test that parses the API's own source to prove it has not drifted.
  - `BENCHMARK.md` reports measured throughput: **1.05× realtime at 1080p**, 3.85× at
    540p, 0.30× at 4K, on a 12-thread desktop. The ≥ 2× target is not met; the file
    contains the stage split showing that Skia and x264 do not overlap because
    rasterising blocks Node's only thread, the two optimisations tried (bounded layer
    surfaces, landed, 0.69× → ~1.1×; a pipe run-ahead buffer, reverted, slower), and the
    worker-thread change that would close the gap.

- **A10b — Meta MMS excluded on licence grounds (D77); tests no longer read a
  developer's `.env`.**
  - `worker_ai/alignment/mms.py` is **deleted**. The common
    `facebook/mms-300m-1130-forced-aligner` export is CC-BY-NC-4.0, which is
    non-commercial. Rung 3 of the `09 §2` chain is now split by language family:
    `IndicWav2VecAligner` (AI4Bharat, **MIT**) for the eleven Indic languages,
    and the new `worker_ai/alignment/xlsr.py` — `jonatasgrosman/wav2vec2-large-xlsr-53-*`
    per-language CTC fine-tunes, **Apache-2.0**, which is what the GPU model
    server already bakes in — for the global ones.
  - `mms` joins `bhashini` in `routing.NEVER_ROUTE`, and the check now covers all
    three places it could come back: a lane in `routing.yaml`, an admin routing
    override, and the aligner registry itself. Each raises at load time. A licence
    exclusion an operator can switch back on is not an exclusion.
  - Each XLSR-53 fine-tune carries its own vocabulary in its own script, so
    nothing is romanised any more; `alignment/romanisation.py` keeps the
    Roman-to-Devanagari projection the Indic heads need and drops the reverse
    table that only MMS used.
  - **Tests no longer depend on the machine's `.env`.** The eval CLI's `--live`
    path calls `load_settings()` against the _process_ environment, so
    `test_live_asks_the_registry_rather_than_the_fixtures` failed on a fresh
    clone with "REDIS_URL is missing" instead of the live-path error it asserts —
    and would have passed for the wrong reason on a machine holding a Sarvam key.
    A `contract_env` fixture now pins the required variables and blanks every
    optional credential. The whole suite was run with `.env` renamed away to
    prove it: 506 passed, 13 skipped, no other test had the same dependency.

- **A12 — api: the EDG module (hot document, `/edg/ops` with server-side rebase
  and compare-and-swap, revisions, snapshots and restore, realtime `edg.ops`).**
  - `apps/api/src/edg/edg.repository.ts`: A02b's `EdgRepository` over Prisma. One
    batch is one transaction — `SELECT … FOR UPDATE` on the document row,
    `rebaseOps` against the ops since the client's base, `applyOps` on a partial
    state, row-level writes, then
    `UPDATE edg_documents SET revision = revision + 1 … WHERE revision = $observed
RETURNING revision`. The lock makes read-decide-write atomic; the CAS is the
    same invariant written into the statement rather than into a convention, so
    `edg_documents.revision` rises by exactly one per accepted batch (06
    invariant 3) even if a later caller forgets the lock.
  - **The working set** (`edg.working-set.ts`). A batch reads the rows its ops
    name plus exactly the neighbours `@montaj/edg/ops` reaches for — the segment
    after the last one addressed (a split mints a `seq` between them), everything
    between the addressed ones (a merge checks contiguity), the segments a deleted
    word bounds, and one transcript chunk either side of each one named. Most
    edits read no words at all: setting text, style, position or `hidden` never
    asks the engine about a word. Measured on the compose Postgres, a single-op
    batch is **median 33 ms, p95 67 ms on a 9,000-segment document** — no slower
    than on a twelve-segment one, which is the claim the design makes.
    `Resegment` is the one op with no bounded form and says so rather than
    guessing.
  - **Rebase, or 409.** A client that is behind is rebased server-side and
    applied (`OpBatchResponse.rebased`). Two things the server may not decide for
    the user come back as `409`: a `conflict` verdict — two writers typing
    different text into the same caption or correcting the same word — carrying
    `{latestRevision, opsSince, conflicts}` with **both texts** and never the
    document (D29); and `edg/too_stale` past 200 revisions or across a state
    replacement.
  - **Word edits touch one row.** `EditWord`, `DeleteWord` and `InsertWordAfter`
    patch only the `transcript_chunks` row the word lives in, raise its
    `next_word_seq` (ids are never reused, 06 invariant 4), and move
    `transcripts.current_revision` only when a word actually changed.
  - **Snapshots** every 100 revisions (`SNAPSHOT_EVERY`, D28) plus one at
    creation, stored without the transcript chunks — they live in their own
    table. `POST /edg/snapshots/{n}/restore` **appends** a revision that replaces
    the state; history is never rewritten, so restoring a later snapshot undoes
    it. A revision with no ops is the log's way of saying "the state was
    replaced", and anybody rebasing across one is told to reload.
  - **Idempotency** on `edg_revisions.client_op_ids` with a GIN index
    (`prisma/sql/0006-a12-edg.sql`): a retry after a dropped response returns the
    revision the first attempt produced instead of applying the edit twice.
  - **Rate limiting** per workspace — 20 batches of burst refilling at 5/s —
    because one seat with twenty tabs is one document being edited. Exhaustion is
    `429 common/rate_limited` whose `details.rejected` marks every op
    `rate-limited`, the one reason in `packages/edg`'s closed enum the API raises
    and the engine never does. Fails open on a Redis outage.
  - **`MergePass` is worker-only.** "worker" is never a claim in a user's token;
    the only route that submits ops as one is
    `POST /internal/projects/{id}/edg/ops`, behind the CONTRACTS §3 HMAC.
  - `EdgService.initialise(projectId, transcript)` — the entry point A11 calls
    once a transcript is segmented. Idempotent by project.
  - Realtime `edg.ops {revision, ops, source}` to `project:{id}` after the commit
    (CONTRACTS §7); the envelope's `at` is the server time.
  - Schema: `edg_pass_items.keyframes_ref` (CONTRACTS §2 freezes
    `PassItem.keyframesRef`; the table had only the bytes column) and
    `edg_segments (edg_id, start_word_id)` / `(edg_id, end_word_id)`, which is how
    a word delete finds the segments it bounds.
- **A16c — per-script type sizes (`typography.scriptScale`) and track-level shrink.**
  - **The problem.** Shrink-to-fit is decided per caption, so a short caption is drawn at
    full size and the next one, one word longer, smaller: the type size jitters shot to
    shot inside one video, and the picker's tile — short preview text, never shrunk —
    shows a size no real caption uses. 28 of 30 styles hit the shrink floor on a
    budget-filling caption.
  - **`typography.scriptScale`**, an optional, additive field on StyleDoc v2 (the schema
    generation stays 2; a document without it renders exactly as before): a per-script
    multiplier on `sizePct`, keyed by the lowercase OpenType tag (`latn`, `deva`,
    `taml`). `render-core` applies the entry for the script it is actually laying out —
    the script of the words on screen, not the project's language — so a Hinglish
    caption picks the right one line by line. `sizePct` keeps recording the size the
    style was drawn for.
  - It exists because the budgets are counted in **base characters** with combining marks
    excluded (that is what reading speed depends on) while width is a different question:
    a 22-character Tamil line is ~37 code points and about **21 em** wide, against 15.3 em
    for a full 32-character Latin line. One size per style cannot satisfy both.
  - `src/styles/fit.ts` measures the worst shrink over the four caption fixtures **and** a
    budget-filling caption per script, at every instant a `wordsPerCue` style rotates
    through, on both canvases; `worstFitForScript` restricts that to the layouts a given
    multiplier can move, which is what makes per-script tuning well-defined.
    `scripts/tune-style-sizes.ts` bisects each multiplier; `src/styles/fit.test.ts` asserts
    shrink ≥ 0.95 at 1080×1920 and ≥ 0.9 at 1920×1080, per script, for all 30 styles.
  - **`computeTrackShrink({projection, catalogue, registry, shaper, canvas, script})`**
    lays every caption out once and returns the minimum shrink per (styleId, script);
    `renderFrame` and `layoutFrame` take the map and apply it uniformly, so every caption
    in a style is one size for the whole video. Per-caption shrink remains the fallback
    when no map is given. It is a pure function and costs one layout per caption, so the
    exporters (A19, A20) and the preview stage compute it once per session — on a change
    of document, catalogue or canvas — and cache it; nothing calls it per frame.
  - Goldens, PNG baselines and the 30 catalogue previews regenerated; browser parity holds
    at 0 pixels differing.
  - **Reported, because it is a product decision.** Latin needed a multiplier below 1 in
    **28 of 30 styles** (0.45–0.94), so Latin does not in fact keep its authored size. The
    cause is the same arithmetic: 32 characters is roughly 16 em, and 16 em inside 78–90%
    of a 1080-wide portrait frame forces an em of ~2.8% of frame height whatever the
    script. The 32/24/22 budgets fit a 16:9 subtitle comfortably (a 4.2% line has ~33 em
    of room there) and are simply generous for 9:16. A 9:16-specific budget — nearer
    20–26 Latin characters — would let every `latn` multiplier go back to 1.
    `word-pop` and `impact-shout` need no multipliers at all: they show one word at a time.
  - **A12b:** a snapshot restore is now validated against the transcript as it
    stands before anything is written. The transcript is deliberately not rolled
    back with the captions, so a snapshot old enough to predate a `DeleteWord`
    still names that word; writing it would leave a caption bounded by something
    nothing can render. `validateProjection` runs over the projection the restore
    would produce, with a word index built from the **live** words only (a
    tombstoned word is as good as a missing one here), and any issue refuses the
    whole restore with `409 edg/restore_invalid` — `details.danglingWordIds`
    names the words, `details.issues` carries the validator's findings.
- **A16c/A16d — line budgets come from the type (decision D78), per-script sizes, and
  track-level shrink.**
  - **The problem.** `09 §3`'s 32/24/22 characters a line are readability caps, and were
    being treated as caption lengths. A full 32-character Latin line is about 16 em; 16 em
    inside 78–90% of a 1080-wide portrait frame needs an em of ~2.8% of frame height. Every
    style was therefore overflowing and shrinking, so two captions in one video were two
    different sizes and the picker's tile showed a size no real caption used.
  - **`fitBudget({style, script, canvas, registry, shaper}) → {maxChars, maxLines}`** in
    `@montaj/render-core`. It measures the average advance per **base character** by running
    a fixed, committed per-script sample through the real shaper with the resolved font, then
    divides the caption box — less box padding, inside the safe area — by it. The answer is
    `min(readabilityCap, whatFits)`, with caps 32/24/22 and two lines. `limitedByFit` says
    which of the two decided; `belowComfortableMinimum` flags a style so large that captions
    are one short word a line, rather than inflating the number and putting the overflow back.
  - `layoutSegment` now wraps at that budget instead of at the table. Wrapping at the cap
    re-joined words the segmenter had deliberately separated, which is what made the caption
    overflow in the first place. The segmenter and the layout now share one number.
  - **`@montaj/edg/segmenter` takes `maxCharsByScript`**, the shape `fitBudget` produces —
    per script, because the segmenter resolves its limit from the script of the run it is
    closing and a Hinglish transcript needs Roman and Devanagari runs to differ. It falls
    back to the flat `maxChars`, then to the table. `packages/edg/README.md` gains
    "Budgets come from `fitBudget`; readability caps are maxima".
  - **`typography.scriptScale`**, optional and additive (StyleDoc stays at generation 2): a
    per-script multiplier on `sizePct`, keyed by lowercase OpenType tag. Every style keeps
    the `sizePct` it was drawn for and **no style carries a `latn` entry**. The Indic entries
    stay on readability grounds, not fit: at the same em a Tamil budget collapses to five or
    six characters, and a modest reduction roughly doubles it.
  - **`computeTrackShrink({projection, catalogue, registry, shaper, canvas, script})`** lays
    every caption out once and returns the minimum shrink per (styleId, script);
    `renderFrame` and `layoutFrame` apply it uniformly so a style is one size for the whole
    video. Per-caption shrink stays the fallback. The value is floored to two decimals
    rather than rounded, because a value a hair above one caption's true need would leave
    that caption at its own size and show two sizes instead of one. It is pure and costs one
    layout per caption, so exporters (A19, A20) and the preview stage compute it once per
    session and cache it; nothing calls it per frame.
  - Tests: `fitBudget` (17), the per-script fit suite driven by the measured budget for all
    30 styles × 3 scripts × 2 canvases at shrink ≥ 0.95 (9:16) and ≥ 0.9 (16:9), track
    shrink (12), and the segmenter's per-script budgets. Goldens, PNG baselines and the 30
    catalogue previews regenerated; browser parity holds at 0 pixels differing.
  - A11 calls `fitBudget` at EDG initialisation from the project aspect and default style;
    A15 offers "Reflow captions" (a `Resegment` op) when a style change moves the budget.
    Neither is implemented here.

- **A16 — `@montaj/render-core`, `@montaj/render-canvaskit`, the 30 system styles and
  the editor's caption canvas.**
  - `@montaj/render-core` is implemented: `(StyleDoc, segment, words, time, canvas) →
DrawCommand[]`, pure TypeScript, HarfBuzz-wasm shaping (`harfbuzzjs` 1.6.1, pinned),
    a `FontRegistry` abstraction and no system fonts (D33). `layoutSegment` produces
    absolute geometry; `animate` turns it into commands as a pure function of time;
    `renderFrame` maps output time to source time through `@montaj/timemap` (D30),
    resolves each visible segment's effective style and draws them in `seq` order.
  - The `DrawCommand` union: `text` (shaped glyph ids with paired absolute positions
    and clusters), `rect`, `roundRect`, `path`, `image`, `group`, `transform`, `clip`,
    `shadow` and `blur` — the last with a `backdrop` flag for the styles that sample the
    video behind them. Fills and strokes take a solid or gradient `Paint`. Everything is
    JSON-serialisable and quantised, so a command list hashes stably and can be stored,
    diffed and shipped to a worker. `outlineTextCommands()` converts every glyph run to
    a path for a backend that cannot draw glyph ids, which is how A20's Canvas2D surface
    executes the same list.
  - Line breaking reproduces the segmenter's split rather than inventing one: the same
    greedy character wrap with the same counting rule (base code points, combining marks
    excluded). Only genuine metric overflow changes anything, and then the answer is
    shrink-to-fit; re-wrapping by width happens only at the shrink floor, and a break
    inside a word only when one word alone is too wide — always on a HarfBuzz cluster
    boundary, so a Devanagari matra or a Tamil conjunct is never cut in half.
  - Sizes stay relative: type, position and safe area off the canvas height, stroke,
    shadow, padding and radius off the font size, so one document renders identically at
    1080×1920 and at the 540p proxy. Document-level overrides are read from
    `styles.inline.doc` and beaten by a segment's own `overrides`.
  - `@montaj/render-canvaskit` executes the command list on Skia-WASM (`canvaskit-wasm`
    0.42.0, pinned): WebGL where available, CPU raster otherwise, both reported to the
    caller. Per-frame Skia objects live in an arena that is released however the frame
    ends, and a missing font or image is reported rather than thrown.
  - The 23 remaining styles in `styles/registry.json` are drawn, so all 30 validate,
    render and have a committed preview. Four need a capability StyleDoc v2 has no field
    for (two gradients, one backdrop blur, two raster passes); that ink lives in
    `render-core`'s `styles/capabilities.ts` keyed by style id rather than in a widened
    frozen schema.
  - `apps/web`: `StylePreviewCanvas` (a style drawn live, still or looping its
    three-second preview), `CaptionStage` (proxy video plus the CanvasKit overlay, safe
    zones, and a draggable caption box that emits exactly one `SetSegmentPosition` per
    drop, scrubbed with `requestVideoFrameCallback`), and the Style/Colors/Look/Anim
    right panel whose every control emits one `SetStyle` at the current scope.
    `/studio/styles` mounts the panel against the system catalogue.
  - Tests: golden `DrawCommand[]` hashes for 30 styles × 4 caption fixtures (Hinglish,
    Hindi, Tamil, English) × 3 instants plus full committed command lists; determinism
    tests; a chromium Playwright lane that executes a stored command list with CanvasKit
    and compares the encoded frame against the PNG Skia-in-Node drew from the same list,
    within D33's parity SLO. `render-core` sits at 99% lines / 93% branches against the
    90/85 gate, and a two-line 1080p frame lays out and draws in **0.11 ms** (p50)
    against a 2 ms target.
- **A25 — api: `notify` consumer, transactional email (SES/SMTP/dev outbox),
  English and Hindi templates, suppression, in-app notifications.**
  - `apps/api/src/notify`: a `MailProvider` port with three adapters chosen once
    at boot by `MAIL_PROVIDER` — `SesProvider` (AWS SDK v3 SESv2, credentials from
    the pod's IRSA role and region from `S3_REGION`, so there is still no mail key
    in CONTRACTS section 1), `SmtpProvider` (pooled nodemailer from `SMTP_URL`;
    Mailpit locally under the new compose profile `mail`), and `DevOutboxProvider`,
    which writes A04's Redis list at A04's key in A04's entry shape plus the
    rendered message and refuses to run in production. A misconfigured transport is
    a startup failure rather than a queue quietly filling with undeliverable jobs.
  - `NotifyService.enqueue({kind, to, locale, data, idempotencyKey})` — the brief's
    payload, carried as the `payload` of the frozen CONTRACTS section 3 envelope so
    a future out-of-process consumer parses the same shape. The idempotency key is
    the BullMQ job id, which is what makes a repeated enqueue a no-op; a message
    produced before a user belongs to anything uses the documented sentinel
    `workspaceId: "none"`, because the envelope requires a non-empty one.
    Enqueueing never throws for a delivery reason: a notification is a side effect
    of work the caller cares about, so a Redis hiccup is logged, exactly as
    `RealtimePublisher` already swallows one.
  - `NotifyConsumer`: one BullMQ `Worker` inside the API process behind
    `NOTIFY_WORKER_ENABLED` (default on; `0` for one-shot processes and test runs,
    the same lever `MONTAJ_SCHEDULER_DISABLED` is for the scheduler). Sending is a
    render and one HTTPS call, so a second deployable would be a rollout and an
    on-call surface for work the API is already sized for. Per job: suppression,
    then a ten-an-hour per-recipient bucket that the account-security kinds skip,
    then a delivery receipt checked before the render and written after the send —
    so the queue's five retries cannot deliver the same message twice. A malformed
    payload or a template missing a variable is an `UnrecoverableError`, because no
    amount of retrying fixes either.
  - Ten templates (`verify-email`, `magic-link`, `password-changed`,
    `device-approval`, `login-new-device`, `parental-waitlist`, `renewal-notice`,
    `low-credits`, `export-ready`, `share-comment`) as hand-written responsive HTML
    plus a real text part, from ICU MessageFormat strings in English and Hindi
    (08 section 6). **No remote images and therefore no tracking pixel**; values are
    escaped before ICU formats them, so a project called `<b>` is text and not
    markup; brand words arrive as `{brand}`/`{support}` from
    `packages/config/src/brand.ts` rather than being written into a string
    (CONTRACTS section 0). `List-Unsubscribe` (RFC 8058 one-click) only on
    `low-credits` and `share-comment` — everything else is transactional or, for
    the pre-debit `renewal-notice`, legally required.
  - `POST /internal/mail/events`: the SES bounce and complaint feed over SNS,
    authenticated by the **SNS message signature** rather than by
    `InternalSignatureGuard`, because SNS will not compute our HMAC. Canonical
    string, RSA-SHA1/SHA-256 verify, and a signing certificate fetched only from
    `https://sns.<region>.amazonaws.com/*.pem` (05 section 8's SSRF rule) — without
    that check the route would let anyone suppress any address they can name. SNS
    posts `text/plain`, so a middleware parses the body for that one route instead
    of widening the global parser. A `SubscriptionConfirmation` is verified and
    logged but never auto-confirmed: confirming is an outbound GET to a URL that
    arrived in a request.
  - Suppression: permanent for a hard bounce or any complaint, a fortnight for a
    transient one, released early by a later `Delivery`. The live set is in Redis
    keyed by SHA-256 of the address (a Redis dump should not be a mailing list) and
    every change — including each message _not_ sent — is an `audit_log` row with
    the address masked, because a cache is not an answer to "why did we stop
    mailing this customer?".
  - In-app notifications: a `notifications` table (`id`, `userId`, `workspaceId?`,
    `kind`, `data`, `readAt`, `createdAt`, both keys cascading so erasure takes the
    bell with it), `GET /me/notifications` and `POST /me/notifications/{id}/read`
    scoped to the user from the access token, and a realtime `notification.created`
    event on the workspace room. Rows carry no body text: wording is rendered per
    locale at read time, so switching language switches the bell.
  - A04's `AuthMailerService` is now a thin adapter onto `NotifyService.enqueue`
    instead of a logger. Its e2e suite completes real sign-up, verification and
    magic-link flows unchanged — delivery became asynchronous, so `auth-harness`
    drains the queue before reading the outbox rather than sleeping and hoping.
  - `MAIL_SNS_TOPIC_ARN` (optional): when set, `POST /internal/mail/events` refuses
    a correctly signed SNS message published to any other topic, and refuses it
    before fetching the certificate. The signature proves AWS published the
    message, not that we own the topic it came from, so an account can sign a
    perfectly valid bounce for any address from a topic of its own. Unset, any
    topic is accepted — a deployment that has not configured it is better off
    receiving bounces than silently discarding them.
  - Auth mail is written in the recipient's language: `users.locale` (default
    `en-IN`) reaches `AuthMailerService` from both call sites, and
    `test/notify-locale.e2e-spec.ts` drives a real sign-up to prove a `hi-IN`
    account receives the Hindi subject and greeting — a chain that runs from the
    sign-up request through the stored row, the notify job and the renderer, and
    that no single-layer test would catch breaking.
  - `tools/runbooks/mail-outbox.js` prints the development outbox.
  - 130 notify tests (template snapshots in both languages, provider selection and
    each adapter, SNS signature verification against a per-run self-signed
    certificate, suppression, retry and idempotency semantics, both bell endpoints)
    plus an HTTP suite for the `text/plain` webhook body. `apps/api` sits at 93.9%
    lines and 87.2% branches against the CONTRACTS section 9 gate of 75/70.
- **A10 — worker-ai: vendor adapters, two-signal LID, routing chain, forced
  alignment, diarisation and the result cache.**
  - `worker_ai/providers/elevenlabs.py`, `sarvam.py`, `assemblyai.py`: the three
    vendor adapters of decision **D12**, behind the A09 `Provider` interface.
    Scribe v2 is one multipart request per chunk with word timestamps and
    diarisation included, which is why a Scribe-routed job runs neither the
    aligner nor pyannote. Saaras v4 is **Batch only** (init, blob upload, start,
    poll, download) because its REST endpoint caps at 30 s of audio, and returns
    chunk-level timestamps only, which is why its lane is `alignment: required`
    (RR-02 F1). Universal-2 is upload / submit / poll and speaks **milliseconds**
    where every other vendor speaks seconds.
  - `worker_ai/providers/http.py`: one retry policy for every vendor — 429 and
    5xx retried with `Retry-After` honoured and jittered exponential backoff,
    every other 4xx fatal, and no credential ever in a log line or an exception
    message.
  - **No vendor key exists yet (A00-06)**, so every adapter is driven by recorded
    HTTP under `worker_ai/fixtures/vendor/` replayed through
    `httpx2.MockTransport` (`evals/replay.py`). `tests/test_vendor_smoke.py` is
    the documented manual path for the day the keys arrive, skipped unless
    `RUN_VENDOR_SMOKE=1`.
  - `worker_ai/lid.py`: the two-signal language identification of **D14** —
    Whisper LID over 60 s + two 15 s windows (or the routed provider's own answer)
    plus a local classifier on the first chunk. The code-mix lane needs _both_
    signals on Hindi/Hinglish and `codeMixScore ≥ 0.3`, because RR-02 F4 measured
    IndicLID's romanised head at F1 0.75 and it cannot carry that decision alone.
    A disagreement takes the acoustic signal and raises `lowConfidence`. The whole
    decision is logged per job and travels in the completion `result`.
  - `worker_ai/routing.py`: `resolve_chain` returns every candidate a deployment
    can run, primary first, so `ai.transcribe` falls through to the next vendor on
    a `ProviderError` instead of failing the job. Admin weights are laid over
    `routing.yaml` from `ROUTING_OVERRIDES_JSON` and, when B13 ships it, from
    `GET /internal/routing`. **Naming Bhashini in a lane is now a load-time
    error** (`NEVER_ROUTE`): its public API is proof-of-concept-only by its own
    terms (RR-02 F3, D63).
  - `worker_ai/alignment/ctc.py`: CTC forced alignment in numpy — the Viterbi pass
    over the blank-interleaved lattice, with the repeated-character rule that is
    the classic place a hand-rolled aligner goes wrong. `IndicWav2VecAligner`
    (MIT) and `MmsAligner` load ONNX checkpoints lazily from
    `WORKER_AI_ALIGN_MODEL_DIR`; `ElevenLabsForcedAligner` is the paid rung; the
    proportional + VAD fallback still needs no model. Roman Hinglish is projected
    onto Devanagari and MMS input is romanised first, both by rule tables.
  - `worker_ai/diarisation/pyannote.py` and `mapping.py`: pyannote
    **community-1** over the whole file through the D15 model server, with speaker
    labels joined onto words by overlap (nearest turn when a word overlaps none).
    Where the provider already labelled the words — Scribe does, and it is priced
    in — pyannote does not run. The **CC-BY-4.0 attribution** is a module constant
    and ships in `engineVersions`.
  - `worker_ai/cache.py`: the `09 §1` result cache, keyed by
    `contentHash + language + provider + model` (plus the lane's mode and the
    chunk span), 30-day TTL, per-entry size cap, Redis or memory or off. A hit
    skips the vendor call and sets `usage.cached`. A cache outage is a miss, never
    a failure.
  - `worker_ai/metrics.py` and `GET /metrics`: Prometheus counters per provider,
    language and lane — calls by outcome, media seconds, estimated paise, cache
    hits, routing fallbacks. No workspace, project or media id is ever a label.
  - `worker_ai/fixtures/speech-5s/`: a five-second **CC0** speech-shaped clip,
    generated by the committed `make_clip.py`, so the `slow` LocalWhisper test
    feeds a model real audio and the eval harness's vendor lanes have media.
  - The eval CLI scores every adapter: `evals run --set vendor-replay --provider
sarvam` replays the recorded session, `--live` calls the configured vendor.
  - **Security fix:** `httpx2` logs every request URL at INFO, and Sarvam's Batch
    API hands back Azure blob SAS URLs with the signature in the query string —
    so that one line would have written a live credential into the pod's logs on
    every job. `logging_setup.configure_logging` now holds the HTTP client
    loggers at WARNING, and `providers/http.py` logs the path with the query
    string stripped (THREAT-MODEL T21).

- **A09 — worker-ai: the BullMQ Python worker, provider interface, VAD and
  chunking, alignment and diarisation registries, evals.**
  - `apps/worker-ai/worker_ai/runtime.py`: one `bullmq.Worker` per `ai.*` queue.
    `ai.vad`, `ai.transcribe`, `ai.align` and `ai.diarise` are implemented;
    `ai.translate`, `ai.transliterate`, `ai.clean`, `ai.pass` and `ai.llm` are
    consumed and answered `worker/not_implemented` naming the work package that
    owns them, so a producer gets an error in seconds instead of a job that rots
    in Redis until the queue-wait sweeper finds it.
  - **Retry semantics against A08.** A job has two BullMQ attempts but one
    `attemptId`, so a failed completion posted on a non-final attempt would move
    the row to `failed` and make the retry invisible. The worker therefore posts a
    failed completion only on the final attempt (`finalAttempt: true`) or when the
    error is non-retryable (`error.retryable: false`) — the two flags
    `markDeadLetterIfFinal` reads — and re-raises either way.
  - `worker_ai/callbacks.py`: the signed progress and completion client of
    CONTRACTS section 3. The body is serialised once, signed as those exact bytes
    and posted unchanged; the worker signs with the primary
    `INTERNAL_CALLBACK_SECRET` only (`INTERNAL_CALLBACK_SECRET_NEXT` is the API's
    verification key during a roll). Bounded retries on transport, 5xx and 429;
    a 4xx is fatal; `applied: false` is reported as the success it is.
  - `worker_ai/vad.py` and `chunking.py`: decision **D14** — a full-file VAD pass,
    then nominal 10-minute chunks cut at the longest silence within ±30 s, never
    mid-region, no overlap. Silero v5 through onnxruntime (torch-free) when a model
    file is configured, and a deterministic energy backend otherwise, which is what
    CI and the property tests run on.
  - `worker_ai/providers/`: the `Provider` interface with a capability record, a
    cost estimate and a `ProviderSubmission` trail, plus a registry that reports
    _why_ an adapter is disabled. `MockProvider` (deterministic, Hinglish sample),
    `LocalWhisperProvider` (faster-whisper, optional `local-asr` extra) and
    `ServerlessWhisperProvider` (the D15 per-second GPU endpoint) ship; ElevenLabs
    Scribe v2, Sarvam Saaras v4 and AssemblyAI are shells carrying their
    capabilities and prices until A10.
  - `worker_ai/routing.yaml` + `routing.py`: the v2 routing table of `09 §1`
    (decision **D12**) as data, read-only, with a resolver that walks a lane and
    takes the first provider the deployment enables.
  - `worker_ai/alignment/` and `diarisation/`: the **D13** registries.
    `ProportionalAligner` distributes words by character length onto the VAD speech
    timeline and repairs monotonicity — the always-available rung; IndicWav2Vec,
    MMS and ElevenLabs FA are shells with their models and licences recorded.
    `NoopDiariser` labels every region `S1`; the pyannote community-1 shell records
    the model name and its CC-BY-4.0 licence.
  - `worker_ai/transcript.py`: stable `"<chunkIdx>:<n>"` word ids, chunk-local and
    dense, with the post-processing hook A11 replaces.
  - `worker_ai/control.py`: `GET /health`, `GET /providers` (every adapter, its
    enable flag and its reason, plus the routing table and both registries) and a
    `POST /evals/run` stub, on port 8091, pod-internal.
  - `worker_ai/evals/`: a fixture-manifest format, WER/CER over normalised text
    (Devanagari danda included), a runner and
    `python -m worker_ai.evals run --set fixtures/hinglish-mini --max-wer 0.15`,
    which is the gate `09 §8` needs to block a routing change on a regression.
  - `apps/worker-ai/Dockerfile` (CPU: ffmpeg, onnxruntime, faster-whisper and the
    Silero model baked in) and `Dockerfile.gpu`, a placeholder documenting the
    serverless-GPU image contract of D15.
  - `worker_ai/policies.py`: A08b's retry, stall and heartbeat table, mirrored from
    `apps/api/src/jobs/jobs.config.ts` and pinned by a parity test that parses the
    TypeScript. `attempts` and `backoff` reach the worker inside the job options,
    but `lockDurationMs`, `stalledIntervalMs` and `maxStalledCount` are `Worker`
    constructor options a worker has to read — and **the progress callback is the
    heartbeat**, so `JobContext.heartbeat()` reposts the last percentage every
    third of the lock and `ai.transcribe` beats while a chunk is inside a provider.
    Without it a ten-minute chunk on a two-minute lock would be declared stalled
    and handed to a second worker mid-transcription.
  - Tests: 321 unit and property tests with the CONTRACTS section 9 coverage gate,
    a callback suite verified against a server that implements the section 3
    signature, and `tests/test_integration.py` — a real BullMQ job from the API's
    own producer modules, consumed by a real worker, completing against the real
    API (`RUN_INTEGRATION=1`).

- **A05 — api: users, workspaces (tax profile), memberships, consent, privacy.**
  - `apps/api/src/users/`: `GET`/`PATCH /me` (name, avatar, locale, onboarding
    state, marketing opt-in, with a change to the opt-in also appending a
    `consent_records` row); `GET /me/data`, the DPDP access and portability right
    — a `dsr_requests` row of kind `export`, a JSON bundle of every row the
    account holds, and a single-use download link carrying 256 bits of entropy
    that expires in an hour; `DELETE /me`, the erasure right — a `dsr_requests`
    row of kind `erasure`, the account marked deleted, the address anonymised to
    an RFC 2606 `.invalid` mailbox and every session revoked in one transaction
    (the cascade over media and transcripts is B16). Both stamp `dueAt` 30 days
    out (DPDP Rule 14). The module also owns `AuditService`, the `audit_log` +
    `access_logs` writer every other A05 module uses.
  - `apps/api/src/workspaces/`: `GET`/`POST /workspaces`, `GET`/`PATCH`/`DELETE
/workspaces/{id}` (settings merged rather than replaced; a personal workspace
    that is the caller's only one cannot be deleted); `PUT
/workspaces/{id}/tax-profile` with the D41 rules — India requires a State code
    from the 36 live GST codes, an optional GSTIN is checked against its base-36
    check digit and must name that same State, currency is derived
    (`IN → INR`, else `USD`) and locked once a subscription exists, and confirming
    a profile stamps the new `billingCountryConfirmedAt` that B01 requires before a
    checkout; `GET /workspaces/{id}/entitlement`, the Free-plan stub cached in
    Redis for 60 seconds (B02 computes it for real); members
    (`GET`/`POST /workspaces/{id}/members`, `PATCH`/`DELETE .../{membershipId}`)
    with exactly one immutable owner, no granting a role above your own, and every
    session of a removed member revoked at once; and `/invitations` — accepted from
    the invitee's own verified address, so the id in the mail is a lookup key
    rather than a bearer secret.
  - `WorkspaceMemberGuard` on **every** `/workspaces/:id` route (THREAT-MODEL T4):
    the id in the path must be the token's `ws` claim, an active membership must
    still exist, and the principal's role is replaced with the one in the database
    so a demotion bites on the next request rather than at the end of the token's
    fifteen minutes. `test/workspace-guard.e2e-spec.ts` enumerates the shipped
    route table from the router and drives every `:id` route as a stranger, as a
    removed member and with no token, so a route added without the guard fails
    without anybody editing the test.
  - `apps/api/src/consents/`: `GET`/`POST /consents` over an append-only
    `consent_records` log (a refusal is a row, a withdrawal closes the grants it
    supersedes, and `users.marketingOptIn` / `analyticsConsentAt` /
    `memoryConsentAt` are mirrored in the same transaction); `reconsentRequired`
    reports an answer given against an older notice (D61, D62).
  - `apps/api/src/privacy/`: `GET /privacy/notice`, the itemised notice's version
    and purpose list, public because a person has to read it before creating an
    account; and `GET /admin/parental-waitlist`, which lives in A08b's
    `AdminModule` behind `AdminGuard` (`users.is_admin`) because the waiting list
    belongs to nobody's workspace and no membership could authorise reading it.
  - **Schema:** `workspaces.billing_country_confirmed_at` (the sign-up default is a
    guess, not a statement the customer made) and the `parental_waitlist` table
    (`sha256(address)`, jurisdiction, age bracket, `notifiedAt`), which
    `ParentalWaitlistService` drains A04's Redis hash into at boot. Migration
    `20260902030000_a05_billing_country_confirmed_and_parental_waitlist`.
  - No new environment variables and no new feature flags; `pnpm gen:client`
    regenerated `packages/api-client` (53 operations).
  - `apps/api/test/db-harness.ts`: the Docker probe waits 60 s rather than 20 s.
    Vitest collects the suite files in parallel, so every Docker-backed suite
    probes the daemon at once, and A05 took that from three suites to five; a
    timeout there does not fail a run, it silently skips every integration suite.
    A daemon that is genuinely absent still fails in milliseconds.

- **A08b — api: dead-letter queue, admin replay, retry/stall policy, job-event
  retention.**
  - `apps/api/prisma`: the `dlq` table (migration
    `20260902030000_a08b_dlq_replay`) — one row per attempt that exhausted its
    retry budget, carrying the queue, the payload, the last error, the attempt
    ordinal and the credit hold a replay has to reserve again — plus
    `jobs.dlq` / `dlq_reason` / `dlq_at` / `attempt_no` and `users.is_admin`. The
    migration **backfills** from the `job.dead_lettered` events A08 wrote when
    there was nowhere else to put them, so no dead letter is lost.
  - `apps/api/src/jobs/dlq.service.ts`: the dead-letter path. The copy is taken
    from the job row _before_ the completion update, so it remembers the hold, and
    it is idempotent on `(jobId, attemptId)` so an at-least-once callback writes
    one row. **Replay** claims the entry with a conditional update (two admins,
    one replay), reuses the same `jobs` row, mints a fresh `attemptId` and
    increments `attempt_no` — which makes the old attempt's late callback a
    `stale_attempt` no-op (THREAT-MODEL T8) — reserves credits again through the
    facade, and adds the BullMQ job last, so every earlier failure unwinds with
    nothing enqueued. **Discard** releases the hold and records a mandatory reason.
  - `apps/api/src/admin`: `AdminGuard`, which reads `users.is_admin` from the
    database on every request rather than from a token claim, so revoking an admin
    takes effect at once; and `GET /admin/dlq`, `/admin/dlq/stats`,
    `/admin/dlq/{id}`, `POST /admin/dlq/{id}/replay`, `/{id}/discard` and the bulk
    `/admin/dlq/replay` and `/admin/dlq/discard`, which **dry-run by default**.
    Every replay and discard writes an `audit_log` row (THREAT-MODEL T20); a
    non-admin is 403.
  - **Retry and stall policy per queue** (`jobs.config.ts`): attempts (media 3,
    ai 2, render 2, notify 5), exponential backoff **with jitter** — an
    un-jittered backoff retries a whole outage into the same dead provider at the
    same millisecond — and lock durations and stall intervals tuned per queue,
    with ten minutes on `ai.transcribe`, `ai.diarise` and `render.video`.
    `heartbeatIntervalMs()` is a third of the lock, and the heartbeat is the
    existing progress callback.
  - **Job-event retention** (D47): `jobs.event-retention`, nightly, deletes rows
    past their own `data.retainUntil` in batches, falling back to `at` for rows
    written before the marker existed. `dlq` rows are never purged.
  - **Metrics** and `GET /internal/metrics`, a Prometheus exposition rendered from
    an in-process registry that also mirrors into the OpenTelemetry metrics API.
    Names follow `infra/observability/METRICS.md` — `montaj_job_completed_total`,
    `montaj_queue_dlq_depth`, `montaj_queue_wait_duration_seconds`,
    `montaj_job_attempts`, `montaj_dlq_resolved_total` — with the A08b brief's
    `montaj_jobs_failed_total`, `montaj_dlq_depth` and `montaj_job_queue_wait_ms`
    emitted as aliases of the same data, because the shipped dashboards and the
    `MontajDlqNonEmpty` / `MontajDlqGrowing` rules query the METRICS.md names.
  - `tools/runbooks/dlq-replay.js`: `stats`, `list`, `show`, `replay` and
    `discard` against the admin API — not against Postgres, because the policy a
    replay has to honour lives in `DlqService`. `replay` and `discard` are dry runs
    unless `--confirm`, and refuse to run with no target.
    `docs/runbooks/dlq-replay.md` is rewritten around the real commands.
  - New optional environment variable `MONTAJ_METRICS_TOKEN` (non-contract): when
    set, `GET /internal/metrics` requires it as a bearer token.

- **A02b — `@montaj/edg` ops engine: apply, rebase, segmenter, snapshots, migrations.**
  - `@montaj/edg/ops`: `EdgState` (hot document, segments by id in `seq` order,
    passes and items, the transcript word index, tombstones and a 10,000-entry
    `opId` idempotency window) with `fromProjection`/`toProjection`, and
    `applyOps(state, ops, ctx)` implementing all 16 ops of CONTRACTS section 2.
    Pure TypeScript with no database access, so the API module (A12) and the
    browser client run the identical code; per-op atomic, so one rejected op never
    rolls back the rest of a batch; `toProjection` is canonical, so two clients
    that applied the same commuting ops in a different order serialise the same
    bytes.
  - `@montaj/edg/ops`: `rebaseOps(incoming, opsSince)` — the D29 transform table.
    Last writer wins per `(target, field)` for the scalar fields; a `Resegment`
    since the base revision invalidates segment-addressed ops but keeps
    word-level ones; a word deleted since the base makes any op naming it
    `stale`; a concurrent edit of the same text — `EditWord` on one word,
    `SetSegmentText` on one `(segment, script)` — is a `conflict` rather than a
    silent drop, so the 409 carries both texts and the client resolves it;
    segments merged away are remapped onto the segment that swallowed them where
    the op still means something, and a `MergeSegments` list grows the children
    of any segment split since the base. It reads only ops, never the document.
  - `MergeSegments` spans the outermost words of the segments it joins rather
    than the first and last segment's own ends: `seq` decides what shows when and a
    client may set bounds that do not follow the transcript, so taking the ends on
    trust could leave a caption whose range ran backwards. Found by the projection
    property, not by a hand-written case.
  - `@montaj/edg/ops`: `snapshot`/`restore`/`replay` over `EdgSnapshotSchema`
    (`{schemaVersion: 2, projection, chunks?}`), and the types-only
    `EdgRepository` (`loadHot`, `loadSegments`, `loadItems`, `appendRevision`
    returning either the new revision or `{latestRevision, opsSince}`,
    `snapshotEvery = 100`) that A12 implements.
  - `@montaj/edg/segmenter`: `segmentWords` with the script-aware limits of
    `09 §3` — Latin 32 characters a line at 20 CPS, Devanagari 24 at 15, Tamil 22
    at 15, anything else 26 at 15 — detected per word by Unicode block, with
    speaker-change and sentence breaks, a 150 ms minimum breakable pause, 700 to
    6,000 ms captions and a merge pass that absorbs anything shorter. Deterministic
    by construction.
  - `@montaj/edg/migrations`: `migrate(snapshot, targetVersion)` with a registered
    `v1` to `v2` step that turns v1's flat word array and index-addressed
    `wordRange: [i, j]` segments into `transcript_chunks` with stable word ids,
    deriving the chunk index from the cumulative `chunkSizes` v1 stored (or from
    10-minute windows when it did not), preserving segment texts and timings.
  - Fixtures: `fixtures/segmenter-golden.json` (Roman Hinglish, Devanagari Hindi
    and Tamil, with the wrapped lines and their character counts so the limits can
    be reviewed by eye, regenerated by `pnpm --filter @montaj/edg golden:build`)
    and `fixtures/legacy-v1-document.json` for the migration test.
  - 253 tests at 98.9% lines and 92.9% branches, over the CONTRACTS section 9 gate
    of 90/85: a table-driven case per op (happy path and every rejection reason),
    the transform table case by case, and eleven fast-check properties — a batch
    that fully applied leaves the document untouched when it arrives twice and a
    replay never re-applies what already landed, commuting ops converge whatever
    the order, `validateProjection` holds after any random op sequence, `rebaseOps`
    never produces an op naming a tombstoned id and never drops a caption-text
    edit silently, and the segmenter covers every live word exactly once inside
    its limits, deterministically. Benchmarks: 1,000 ops on a 9,000-segment
    document in ~20 ms (budget 200 ms) and 54,000 words segmented in ~205 ms
    (budget 500 ms).

- **A04 — api: auth (email/password, Google PKCE, magic link, refresh families,
  device grant, token exchange, sessions).**
  - `apps/api/src/auth/`: sign-up with the D60 age gate (India under 18 and the EU
    under 16 are refused with `auth/age_restricted` and offered a parental-consent
    waitlist) and per-purpose consent written into `consent_records`; email
    verification and magic links as single-use Redis tokens; login over argon2id
    (64 MiB, t=3, p=1) with a feature-flagged, fail-open breached-password check
    against HIBP's k-anonymity range API; Google sign-in with PKCE, a single-use
    state entry and a handoff code so no token ever rides in a redirect URL, plus
    the https `/auth/desktop-landing` page that triggers the deep-link scheme for
    desktop and panel clients; the RFC 8628 device grant with an 8-character
    unambiguous user code, a 10-minute TTL, a five-per-address cap on flows in
    flight, a server-enforced poll interval and an approval screen naming the host
    application, the device, the address and a coarse location; RS256 access
    tokens carrying exactly the CONTRACTS section 5 claims; refresh-token families
    rotated in place with a 60-second grace that replays the same pair, and reuse
    outside the window revoking the whole family and auditing it; workspace token
    exchange, session listing and session revocation.
  - `apps/api/src/common/guards/`: `JwtAuthGuard`, `RolesGuard`, `ApiKeyGuard`
    (B14 issues the keys; the guard and the scope check ship now), `@Public()`,
    `@Roles()`, `@CurrentUser()`, `@CurrentWorkspace()`, and a Redis token-bucket
    rate limiter behind `@RateLimit(...)` that answers 429 with `Retry-After`.
  - `apps/api/src/users/`: the minimal accounts surface auth needs — create a user
    with a personal workspace, an owner membership and the consent rows in one
    transaction, look one up, and answer membership questions.
  - `pnpm gen:client` regenerates `packages/api-client/openapi.json` and
    `src/generated/operations.ts` from the API's own OpenAPI document.
  - `TRUST_PROXY` (local process setting, not part of CONTRACTS section 1): the API
    reads the client address from `X-Forwarded-For` only when it is `1`, so per-IP
    rate limits cannot be side-stepped by setting the header.
  - Tests: 53 e2e cases against a real PostgreSQL and Redis (testcontainers) plus
    unit suites for the token service, the password policy, the guards, the age
    gate and the token primitives. THREAT-MODEL T1–T4 are mapped to evidence in
    `apps/api/src/auth/README.md`.
  - Fixed `apps/api/vitest.config.ts`: `mergeConfig` takes two configs and a
    boolean, so the four-argument call had been silently dropping the CONTRACTS
    section 9 coverage gate and the exclude list.

- **A08 — api: jobs module, realtime gateway, idempotent completion callbacks,
  no-op `CreditsFacade`, admission control.**
  - `apps/api/src/jobs`: `JobsService` — the producer for every queue in
    CONTRACTS section 3 — with the enqueue order that makes the whole thing safe
    (dedupe by `jobKey`, admission control, `jobs` row, `CreditsFacade.reserve`,
    BullMQ add, `job_events`), so a job that reaches Redis always has a row and a
    credit hold behind it and every earlier failure unwinds cleanly. Cursor-paged
    `GET /jobs`, `GET /jobs/{id}`, `GET /jobs/{id}/events` and
    `POST /jobs/{id}/cancel`, all scoped to the token's workspace, with another
    workspace's job answering 404 rather than 403 (THREAT-MODEL T5).
  - **Admission control** (THREAT-MODEL T23): per-workspace enqueued-credit cap
    (429 `jobs/enqueue_cap`), concurrency lane (429 `jobs/concurrency_cap`),
    per-plan `maxQueueWaitMs` swept every 30 s into `jobs/queue_timeout` with the
    hold released, and the free-tier daily allowance enforced in the facade.
  - `apps/api/src/internal`: the signed worker callbacks —
    `POST /internal/jobs/{id}/progress`, `/complete`, `/enqueue-child` and
    `PATCH /internal/media/{id}` — behind `X-Montaj-Signature`
    (`hmac_sha256(secret, timestamp + "." + rawBody)`), a five-minute skew window
    and constant-time comparison. Completion is idempotent on `(jobId, attemptId)`
    through a conditional `UPDATE ... WHERE status IN ('queued','running')`, so a
    replay answers 200 and settles nothing (THREAT-MODEL T8/T9). Two-key rotation
    via the new optional `INTERNAL_CALLBACK_SECRET_NEXT`. The whole surface is
    excluded from `/docs`.
  - `apps/api/src/realtime`: `/realtime` over plain `ws` — authentication at the
    upgrade (`Sec-WebSocket-Protocol: aksharo.v1, bearer.<token>`, or an
    `Authorization` header), rooms `project:{id}` / `workspace:{id}` authorised
    against the token's workspace _and_ a live membership, Redis pub/sub fan-out
    with reference-counted subscriptions, a 30-second heartbeat and documented
    reconnection semantics (`apps/api/src/realtime/README.md`). The four events of
    CONTRACTS section 7 are typed now; A12 and B15 emit two of them later.
  - `apps/api/src/credits`: the CONTRACTS section 4 `CreditsFacade` interface plus
    a `grantLot` signature for Wave 3, and `NoopCreditsFacade` — real shape, real
    idempotency, no ledger. B02 changes one `useClass`.
  - `apps/api/src/common/scheduler`: `ScheduledTasksService`, cron for the API on
    BullMQ job schedulers, so periodic work is one registration rather than a
    timer per module. `jobs.queue-timeout` is its first task.
  - `tools/runbooks/queue-drain.js`: pause a queue, wait for its active jobs to
    drain with a timeout, print the counts; `--status`, `--resume`, `--json`.
  - New optional environment variables: `INTERNAL_CALLBACK_SECRET_NEXT`
    (CONTRACTS section 1, rotation), and the non-contract `MONTAJ_QUEUE_PREFIX`
    (defaults to BullMQ's own `bull`) and `MONTAJ_SCHEDULER_DISABLED`.
- **A03c — api: `PassStatus.succeeded` becomes `ready`.**
  - `@montaj/edg`'s `PassStatusSchema` is the source of truth for the pass
    lifecycle; A03 had written `succeeded` by analogy with `JobStatus`, but a pass
    whose job succeeded is not finished — its items are `ready` for review, and
    only a `MergePass` op moves it to `merged`. Migration
    `20260902020000_pass_status_ready` renames the value in place (no row rewrite);
    `JobStatus.succeeded` is untouched, since it mirrors the completion callback of
    CONTRACTS section 3.
  - The integration suite now compares `PassStatus` and `ItemState` in the database
    against the package's own enums, so this class of drift fails a test instead of
    reaching a client.

- **A03b — api: seq is a base-62 string; style loader hardened.**
  - `edg_segments.seq` becomes `text COLLATE "C"` (migration
    `20260902010000_edg_segment_seq_text`). A03 read 06's "seq numeric" literally;
    A02 has since shipped `seqBetween()` in `@montaj/edg`, which returns base-62
    keys such as `1B` and `Zz` that no NUMERIC column can hold. The alphabet
    `0-9A-Za-z` is in ASCII order so that `ORDER BY seq` is the comparison
    `compareSeqKeys()` makes, which holds only under byte collation — pinned on the
    column because managed Postgres usually defaults to a linguistic one, and
    asserted by a test that inserts `1`, `1B`, `2`, `Zz`, `a`, `zzzV`.
  - `edg_segments_live_seq_idx` becomes UNIQUE: two _live_ segments may not share a
    fractional key. Partial rather than a plain unique constraint, because a
    tombstoned segment keeps its key and a later edit may legitimately reclaim it.
  - The seed's style loader takes an injected module loader, so the fixtures and
    placeholder tiers stay testable now that `@montaj/caption-styles` always
    resolves; the fixtures tier accepts only documents that parse as StyleDoc v2
    with an `id`, so `styles/registry.json` — the catalogue index A02 ships
    alongside the styles — is no longer seeded as a style.
  - `pnpm db:seed` now reports `source: package` and seeds A02's seven system
    styles.

- **A02c — `@montaj/timemap`: source ↔ output time mapping (D30).**
  - `buildTimeMap({sourceDurationMs, edits, fps?, snapCutsToFrames?})` turns a list of
    `cut`, `speed` and `hold` edits into a frozen, ordered span list covering both
    clocks, with `O(log n)` lookups either way: `toOutput` (`null` strictly inside a
    cut), `toSource` (total — the inverse used for scrubbing), `locateSource` /
    `locateOutput` for the same answers with `insideCut`, `held` and `clamped` attached,
    and `mapRange` for a source range split by cuts.
  - Sample-accurate boundary rules: a cut removes the half-open source range, both its
    edges map to the one output splice, and `toSource` of that splice is the frame after
    the cut. Cuts win every conflict — overlapping and touching cuts merge, speed ranges
    are clipped out of them, holds strictly inside one are dropped — and structurally
    invalid edits raise a typed `TimeMapError` with a stable `code`.
  - Caption helpers: `mapSegment` (a segment whose live words all fall in cuts is
    hidden, partial overlaps are clipped, tombstoned words ignored) and `mapWord`;
    `mapKeyframes`, which drops keyframes inside cuts and pins the curve with an edge
    keyframe at each side of every splice it crosses, optionally interpolated.
  - `fromAcceptedItems(items, {sourceDurationMs, …})` builds a map from accepted `cut`
    pass items and ignores every other kind; `serialize()` / `parseTimeMap()` are a
    versioned JSON fixed point; `snapToFrame`/`frameDurationMs`/`frameAt` work on the
    exact frame grid, and `snapCutsToFrames` puts every cut edge on a boundary.
  - Guarantees proved with fast-check: monotonicity both ways, exact inverse on retained
    source when nothing is retimed (and a stable round trip on both clocks for every
    map), `outputDurationMs === sourceDurationMs − Σcuts + Σholds`, and `mapRange` pieces
    that are ordered, disjoint and cover exactly the retained part of the input range.
  - Pure and browser-safe (no Node-only imports, asserted against the build output);
    CommonJS in `dist/` and ES modules in `dist/esm/` with declarations for both.
    149 tests, 100% lines / 99.6% branches against the CONTRACTS section 9 gate (90/85).
    5,000 cuts on a six-hour source: 100,000 `toOutput` lookups in ~15 ms.
- **A03 — api: Prisma schema v2, hand SQL, migrations, seed, base modules.**
  - `apps/api/prisma/schema.prisma`: 68 models covering every table in
    `03-architecture/06-data-model.md` — identity and tenancy, media and editing
    (EDG v2, including `transcript_chunks`, the six `edg_*` tables, `style_presets`,
    `brand_kits`, `fonts`, `memory_entries`, `comments`, `share_links`,
    `share_reports`), jobs and outputs (with `provider_submissions` and
    `export_manifests`), billing and credits (`mandates`, Rule 46 `invoices`,
    `payments`, `firc_records`, `tax_registrations`, and the four credit tables),
    growth and the content/ops tables. ULID `char(26)` ids, `timestamptz`
    throughout, money as integer minor units beside a currency, credits as integer
    tenths, snake_case columns, and every JSONB column commented with the Zod
    schema that validates it.
  - `apps/api/prisma/sql/`: hand-maintained DDL applied straight after
    `prisma migrate deploy` — the `vector` extension, 31 partial and vector indexes
    (lot consumption order with `NULLS LAST`, retention sweeps, live-session and
    pending-device-code slices, an HNSW cosine index on `audio_assets.embedding`,
    and NULL-safe uniqueness for system style presets), 13 CHECK constraints
    holding the invariants of 06 (no UPI mandate above ₹15,000, no negative credit
    balance or over-consumed lot, a State code on every Indian invoice), and table
    comments recording the retention rules where `\d+` shows them.
  - `pnpm --filter @montaj/api db:migrate` (migrate deploy + idempotent hand SQL,
    tracked in `_montaj_sql_applied`), `db:seed`, `db:reset`, `db:sql`;
    `prisma generate` wired into `postinstall` and `build`; the CONTRACTS section 9
    coverage gate for `apps/api` (75/70).
  - `prisma/seed.ts`: the five plans of `04 §Plans` with INR/USD prices, monthly
    credit grants and entitlements whose operation gating is **derived** from the
    burn-rate table in `@montaj/config`; the system caption styles with their
    parity flags left at the pessimistic defaults only the A18a gate may write;
    four feature flags, all off; an admin user and a demo personal workspace with a
    credit account, lot and ledger row that satisfy invariant 1, and a free-plan
    subscription. Idempotent: every row is keyed on a natural key or a
    deterministic ULID.
  - `apps/api/src/common`: `PrismaService` (eager connect, shutdown hooks,
    `withTransaction`), `RedisService`, pino logging with request-id correlation
    and redaction of secrets and emails (THREAT-MODEL T21), an AsyncLocalStorage
    `RequestContext` carrying `requestId`/`userId`/`workspaceId`, a global
    exception filter producing the CONTRACTS section 8 envelope, a thin Zod
    validation pipe with `zodDto()`, and an OpenTelemetry bootstrap that is a
    genuine no-op when no OTLP endpoint is configured.
  - `GET /health/ready` reports Postgres, Redis and object-store reachability and
    answers 503 when any of them is down; `GET /health` stays dependency-free.
  - 109 tests: unit suites for redaction, request context, error codes, the
    exception filter, the validation pipe, telemetry and the health service; HTTP
    e2e for the error envelope (unknown route and validation failure) with no
    infrastructure; and an integration suite on a testcontainers
    `pgvector/pgvector:pg16` asserting all 68 tables against `information_schema`,
    the named indexes and constraints, seed idempotency, and a segment round trip
    in fractional `seq` order.
- **A02 — `@montaj/edg` v2 and `@montaj/caption-styles` v2 schemas + fixtures.**
  - `@montaj/edg`: Zod schemas and inferred types for the whole EDG v2 document —
    `WordId`, `Word`, `TranscriptChunk`, `TranscriptManifest`, `Segment`, `Pass`,
    `PassItem` (a discriminated union with a typed payload per `kind`), `EdgHot` and
    `EdgProjection` — plus the complete 16-member `EdgOp` union and the
    `OpBatchRequest`/`OpBatchResponse`/`OpConflict` envelopes from CONTRACTS section 2.
  - `@montaj/edg` helpers: a monotonic ULID factory, `makeWordId`/`parseWordId`,
    base-62 fractional ordering for `Segment.seq` (`seqBetween`, proved with
    fast-check), `buildWordIndex`/`wordsBetween` over transcript chunks, and
    `validateProjection` for the document invariants.
  - `@montaj/edg` artefacts: `schemas/edg-v2.json` and `schemas/edg-ops-v2.json`
    generated from the Zod schemas at build time and guarded by an "up to date" test;
    `fixtures/sample-project.json` (90 s, 3-speaker Hinglish, 12 segments, an autocut
    pass with 4 cut items and a reframe pass with 1 zoom item) with its matching
    transcript, validated by Ajv against the generated schema.
  - `@montaj/edg` build: CommonJS in `dist/` and ES modules in `dist/esm/`, each with
    declarations, behind the `.`, `./schemas` and `./seq` subpath exports.
  - `@montaj/caption-styles`: the `StyleDoc` v2 schema (typography, colours, box,
    stroke, shadow, layout, animation, emphasis presets, `minPlan`, CI-written parity
    flags), the D64 naming-rule validator with an admin-extendable deny-list in
    `src/naming/denylist.json`, seven system styles (`punch-pop`, `hype-bold`,
    `vertical-clean`, `karaoke-fill`, `podcast-duo`, `word-pop`,
    `minimal-lower-third`), a 30-style `styles/registry.json` and
    `loadSystemStyles()`, which A03's database seed loads.
  - Coverage gates per CONTRACTS section 9: 90/85 on both packages.

- **A01 — Monorepo scaffold, tooling, CI, docker-compose, env.**
  - pnpm 9 workspaces (`apps/*`, `packages/*`, `plugins/*`, `engine/*`) driven by
    Turborepo 2, with cached `build`, `lint`, `typecheck`, `test`, `test:e2e`,
    `db:migrate` and `db:seed` tasks.
  - `@montaj/config`: strict TypeScript bases (ES2022, NodeNext, React), the shared
    ESLint flat config, the Prettier config and the Vitest preset; `BRAND` per
    CONTRACTS section 0; the credit burn-rate table as typed constants; a Zod schema
    for every variable in CONTRACTS section 1 with a fail-fast `loadEnv()`.
  - Package skeletons with a passing test and a README each: `edg`, `timemap`,
    `caption-styles`, `render-core`, `render-canvaskit`, `render-skia-node`,
    `ass-exporter`, `api-client`, `ui`, `prompts`.
  - `apps/api`: NestJS 11 with `GET /health`, OpenAPI at `/docs` (JSON at
    `/docs-json`), a config module built on `loadEnv()`, an empty Prisma schema plus
    `prisma/sql/` for hand-maintained DDL, and a supertest e2e suite.
  - `apps/web`: Next.js 15 App Router, React 19, Tailwind v4 and shadcn/ui, with a
    placeholder page per route group (`(site)`, `(app)`, `(share)`, `(admin)`), a
    `/health` route handler and a Playwright smoke test on chromium and webkit.
  - `apps/worker-media`: BullMQ worker on `media.probe` with a stub processor and an
    ffmpeg/ffprobe boot check that refuses to start with clear install instructions.
  - `apps/worker-ai`: Python 3.12 project (pip-tools locks, ruff, `mypy --strict`,
    pytest, hypothesis) with a BullMQ worker on `ai.transcribe`, a FastAPI control
    app serving `GET /health`, and the abstract `Provider` interface.
  - `apps/render`: BullMQ worker on `render.video` with a stub processor.
  - README-only placeholders for `apps/desktop`, `apps/bridge`, `plugins/premiere-uxp`,
    `plugins/ae-cep`, `plugins/resolve` and `engine/montaj-engine`.
  - `docker-compose.yml`: Postgres 16, Redis 7 and MinIO with healthchecks, plus a
    one-shot `mc` bootstrap creating `montaj-raw` and `montaj-derived`; and
    `docker-compose.override.example.yml`.
  - `.env.example` covering all 31 CONTRACTS section 1 variables with local defaults.
  - GitHub Actions CI: TypeScript (Node 22), Python (3.12), a Playwright smoke lane
    and a `docker compose config` lane, with a concurrency group.
  - Repo hygiene: `.editorconfig`, `.gitattributes`, `.gitignore`, `.nvmrc`,
    `.node-version`, `CODEOWNERS`, `LICENSE`, the pull-request Definition-of-Done
    template, and `docs/adr/0001-monorepo-tooling.md`.

- **X05 — Infrastructure as code (staging/prod skeleton, no apply).**
  - `infra/terraform`: root modules `envs/staging` and `envs/prod` over nine
    reusable modules — `network` (VPC, three subnet tiers, NAT, S3 gateway
    endpoint, flow logs), `eks` (control plane, managed node groups with an
    optional GPU pool, addons, IRSA, access entries), `rds-postgres16` (PITR,
    KMS-encrypted, `pg_stat_statements` preloaded, `vector` allow-listed for
    A03's pgvector column), `elasticache-redis7` (`maxmemory-policy noeviction`,
    a BullMQ correctness requirement), `s3-raw` (`ap-south-1`, SSE, versioning
    with 7-day non-current expiry, 1-day abort-incomplete-multipart, CORS for
    presigned PUT from `WEB_ORIGIN`), `r2-derived` (bucket, CORS, and a
    multipart-abort rule on the `ws/` root — plan retention is swept by the
    scheduler in B16, not by lifecycle, because CONTRACTS section 6 keys are
    frozen), `secrets` (KMS plus one SSM parameter per
    CONTRACTS section 1 variable), `dns-cdn` (`aksharo.ai`, `app.`, `api.`,
    zone TLS settings, null-MX/SPF/DMARC) and `github-oidc` (keyless deploy
    role). `backend.tf` is a partial S3 backend with native locking; every
    variable is documented; no credential is committed.
  - `infra/gpu`: RunPod serverless endpoint definition with a warm floor of one
    per region and queue-delay autoscaling (decision D15), the model-server
    Dockerfile with large-v3-turbo, forced alignment and pyannote community-1
    pre-baked, a Modal equivalent, and `COST.md` showing the arithmetic behind
    the `05 §12` cost band rather than restating it.
  - `infra/k8s/montaj`: Helm chart for `api`, `web`, `realtime`, `worker-media`,
    `worker-ai`, `render` and `scheduler`, with HPAs on CPU for the
    request-serving components, KEDA ScaledObjects on BullMQ queue depth for the
    workers, PodDisruptionBudgets, default-deny network policies plus an optional
    Cilium FQDN allow-list, external-secrets pulling all 31 contract variables
    from SSM, TLS ingress, resource requests and limits, and
    `values-staging.yaml` / `values-prod.yaml`.
  - `infra/observability`: `METRICS.md` defining the OTel metric contract
    (names, units, labels, cardinality rules); two Grafana dashboards covering
    API latency, queue depth per queue, job success rate, GPU utilisation and
    COGS per credit; and a `PrometheusRule` with 4 recording rules and 24 alerts.
  - `docs/runbooks/`: deploy, rollback, rotate secrets, restore from PITR, scale
    GPU, DLQ replay and a breach first-hour checklist wired to THREAT-MODEL.
  - `.github/workflows/infra.yml`: the `infra-validate` job — `terraform fmt`,
    `terraform validate` against a mock backend for every module and both
    environments, `tflint`, `helm lint`, `kubeconform -strict`,
    `promtool check rules`, plus checks that the SSM map and the chart match
    CONTRACTS section 1 exactly, that the lifecycle rules encode the retention
    contract, that worker egress is denied by default, and that nothing
    credential-shaped is committed.

### Fixed

- **A08c — `RedisRealtimeBus` could not subscribe against a real Redis.** Reported
  by A12. `RedisService` builds its client with `lazyConnect: true` and
  `enableOfflineQueue: false`; `duplicate()` inherits both, so the realtime
  subscriber sat in `wait` and its very first `SUBSCRIBE` was rejected outright
  with `Stream isn't writeable and enableOfflineQueue options is false` rather than
  being queued until the socket opened. Nothing retried it, so every room was
  silently never delivered to — in production only, because the realtime e2e ran
  over `InMemoryRealtimeBus` and the Redis fake reported `ready` from its first
  moment. `RedisRealtimeBus` now connects each client explicitly before issuing a
  command (subscriber _and_ the shared publishing client, which has the same
  problem on an instance whose first Redis traffic is a realtime publish), waits
  for `ready` when another caller is already connecting, and skips an
  `UNSUBSCRIBE` on a connection that never came up.
  - `RealtimeGateway` no longer lets a fan-out failure escape: a room whose
    subscription cannot be established is refused with
    `refused: [{room, reason: "unavailable"}]` and its local membership rolled
    back, and the fire-and-forget frame handler catches instead of turning a
    rejection into a process exit.
  - `apps/api/test/realtime-redis.e2e-spec.ts` runs the real bus, the real
    `RedisService` options and two gateway instances against the compose Redis,
    publishing on one and receiving on the other; the unit suite gained a Redis
    fake with the lazy lifecycle, because the old one was `ready` from the start
    and could never have caught this.

- **A08b — `jobKey` deduplication was scoped globally, not per workspace.** A08's
  `jobs_live_job_key_key` was `UNIQUE (job_key) WHERE status IN
('queued','running')` with no workspace column, so two tenants with the same
  live job key collided and the second enqueue failed with an unexplainable unique
  violation. `prisma/sql/0005-a08b-dlq.sql` replaces it with
  `jobs_live_workspace_job_key_key` on `(workspace_id, job_key)`, and
  `JobsService.enqueue` now handles the unique violation by returning the existing
  job — the `findLiveByKey` read cannot exclude a writer that commits a
  microsecond later, so the index is the actual guarantee.

### Changed

- **A06 — `WorkspaceMemberGuard` now guards routes with no workspace id in the
  path.** On a `/workspaces/:id` route both of its rules are unchanged; on a route
  without an `:id` — every `/projects/*` route — there is nothing to compare, so it
  performs only its second check (an active membership still exists, and the
  principal's role is re-read from the database). It previously returned `true`
  there, which was correct while only `/workspaces/:id` wore it and would have been
  a silent hole the moment another controller did.
- **A06 — `/jobs` moved onto A04's `JwtAuthGuard` and the interim access-token
  guard is deleted.** `JobsController` now uses `JwtAuthGuard`,
  `@CurrentWorkspace()` and `RolesGuard` (reads are `viewer`, cancel is `editor`),
  and `src/realtime/auth/access-token.guard.ts` is gone. `AccessTokenService`
  stays: a WebSocket handshake is not a Nest route, and the gateway has to verify
  the token itself. A04's verifier pins the `iss` claim to `API_ORIGIN`, which the
  interim guard did not check, so A08's e2e suite mints tokens with it.
- **A06 — schema.** New `folders` table, `projects.folder_id` converted to a real
  foreign key, `media_assets` gains `filename`, `upload_id`, `part_size_bytes`,
  `needs_realign`, `thumb_keys`, `raw_purged_at` and `derived_purged_at`, and
  `MediaRole` gains `subtitle`
  (`prisma/migrations/20260902050000_a06_folders_media_upload`).
- **A25** — `.env.example`, `packages/config/src/env.ts`, the Terraform secrets
  contract and the Helm chart all gained `MAIL_PROVIDER`, `MAIL_FROM` and
  `SMTP_URL`, the three variables CONTRACTS section 1 added after A04, and
  `GPU_PROVIDER_URL` (non-secret) and `GPU_PROVIDER_TOKEN` (secret, human-filled),
  the two it added after A09 — A25 was the next work package to touch all four
  files, so it carried them across rather than leaving the parity check red.
  `MAIL_SNS_TOPIC_ARN` followed after A25's first review.
  `apps/worker-ai/worker_ai/settings.py` mirrors that list and its test enforces
  the mirror, so the six names were added there too and the GPU pair moved out
  of `WORKER_ENV_VARS`: they are product configuration now, not deployment
  naming. `infra/scripts/check-contracts-parity.py` reports 38/38 on both sides.
  `loadEnv()` also gained a cross-field check (`crossFieldProblems`): `ses` and
  `smtp` require `MAIL_FROM`, and `smtp` requires `SMTP_URL`. It lives beside the
  schema rather than inside it because a `.superRefine()` would remove
  `envSchema.shape`, which the contract test walks.
- **A25** — `REALTIME_EVENTS` gained `notification.created`, now also named in
  CONTRACTS section 7.
- **A25** — `UsersService.findByEmail` selects `locale`. It is the only lookup the
  auth flows do before sending a message, and A25 renders that message in the
  recipient's language; the alternative was a second query on the sign-in path.

- **A02b** — `OpRejectionReasonSchema` gained `invalid-range`, `not-contiguous`,
  `invariant`, `rebased-away` and `stale-after-resegment`. The reason list is a
  closed enum that the ops engine was always meant to extend rather than send free
  text (A02 said so in `packages/edg/README.md`); `schemas/edg-ops-v2.json` is
  regenerated to match. `EdgSourceSchema` was lifted out of `EdgOpsEventSchema` so
  the engine can name the writer that submitted a batch — the same six values,
  now a `$def`.
- **A03** — `docker-compose.yml` now runs `pgvector/pgvector:pg16` instead of
  `postgres:16`. `audio_assets.embedding` is a `vector(512)` column, so stock
  Postgres cannot apply the first migration. Managed Postgres needs `vector` on
  its extension allow-list (X05).
- **A03** — `@typescript-eslint/consistent-type-imports` is off for
  `apps/api/src/**`. A constructor parameter's type is the DI token NestJS resolves
  from `design:paramtypes`, and `import type` erases it to `Object`, so the
  provider fails to resolve at runtime while the code still type-checks.

[Unreleased]: https://github.com/aksharo/montaj/compare/main...HEAD
