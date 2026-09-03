# @montaj/render

The cloud render service. `@montaj/render-core` produces `DrawCommand[]`,
`@montaj/render-skia-node` (`@napi-rs/canvas`, Skia) rasterises them into RGBA overlay
frames, and ffmpeg overlays and encodes straight to R2.

**Status:** implemented (A20). Consumes `render.video` and `render.subtitle`.

There is no headless Chromium and no Remotion in this path (decision D33): the browser,
the desktop app and this service all execute the _same_ draw commands through a Skia
backend, which is what makes the parity gate meaningful.

## The shape of a render

```
render.video job
  │
  ├─ 1. verify the manifest ─── signature, then expiry ─── refuse, non-retryable
  ├─ 2. build the timemap ───── D30; cuts decide the output length
  ├─ 3. check the caps ──────── against the *rendered* length ─ refuse, non-retryable
  │        ↑ nothing above this line touches the network
  ├─ 4. download the source ─── S3 (raw) or R2 (proxy)
  ├─ 5. probe it ────────────── ffprobe: real size, rotation, is there audio
  ├─ 6. draw and encode ─────── Skia frames → pipe → ffmpeg → mp4/mov/webm
  └─ 7. upload ──────────────── R2, CONTRACTS §6, then the signed completion callback
```

The order is the security order, not the convenient one. A manifest that does not verify,
or a 4K request on a 1080p plan, is refused **before a byte of media moves** — so the
cheapest possible thing happens to the most likely abuse.

Everything the pipeline touches is injected (`RenderDependencies`), so the end-to-end
test is the production code path with different objects passed in.

## The manifest is the instruction

`POST /projects/{id}/exports` returns a **server-signed** `RenderManifest`
(`@montaj/render-manifest`), and this service will not draw a frame without one.

Two fields decide money and neither may come from the job payload:

- **`watermark`** — `{assetId, position, opacity}` or `null`. An unentitled workspace
  never receives a manifest with `null` there, and stripping it from a signed document
  invalidates the signature (THREAT-MODEL T10). `src/render/pipeline.test.ts` runs that
  exact attack.
- **`caps`** — the workspace's real entitlement, checked against the rendered length.

`INTERNAL_CALLBACK_SECRET` signs it, with `INTERNAL_CALLBACK_SECRET_NEXT` accepted as a
second verification key, so one rotation procedure covers both the manifest and the
callbacks. There is no new secret and no new environment variable.

## The ffmpeg graph

```
 ┌ input 0: the source file ───────────────────────────────────────────────┐
 │  [0:v] trim/setpts per retained span ─┐                                 │
 │  [0:a] atrim/asetpts per span ──────┐ │                                 │
 └─────────────────────────────────────┼─┼─────────────────────────────────┘
                                       │ └→ concat(v) → scale → crop → fps ─┐
 ┌ input 1: stdin, rawvideo rgba ──────┼───────────────────────────────────┼┐
 │  Skia draws one frame per output    │                                   ││
 │  instant and writes it here ────────┼──────────────→ [1:v] ─────────────┼┤
 └─────────────────────────────────────┼───────────────────────────────────┘│
                                       │                         overlay ←──┘
                                       └→ concat(a) → aout       ↓
                                                          libx264 → +faststart
```

Three decisions worth stating:

1. **Cuts are `trim` + `concat`, not `select`.** `select` needs an expression over every
   frame and leaves the audio to a parallel `aselect` that has to agree with it; `trim`
   consumes the span list `@montaj/timemap` already computed, and `concat` guarantees
   video and audio are cut at the same instants — the property captions depend on.
2. **`fps` sits immediately before `overlay`.** The Skia side produces exactly one frame
   per output instant `n/fps`; forcing the base to the same rate is what keeps the two
   streams aligned after a concat of spans whose lengths are not whole frames.
3. **The overlay is a second input on a pipe.** Nothing is buffered to disk and the
   back-pressure is ffmpeg's own: when the encoder is behind, the pipe fills and the
   frame loop waits.

Full command lines, including the cut and scale/crop variants, are in
[`BENCHMARK.md`](BENCHMARK.md).

### Output shapes

| `output.kind` | What it is                                         | Codec                                            |
| ------------- | -------------------------------------------------- | ------------------------------------------------ |
| `video`       | captions over the decoded source                   | H.264, `veryfast`, CRF 20 (1080p) / 18 (4K)      |
| `alpha`       | the caption layer alone, with a real alpha channel | ProRes 4444 (`yuva444p10le`) or VP9 (`yuva420p`) |
| `greenscreen` | the caption layer over a solid chroma ground       | H.264                                            |

Alpha and green-screen are **cloud-only** (`03 F-502`): RR-04 could not verify
`VideoEncoderConfig.alpha: "keep"` in any shipping browser, so there is no browser twin.

### Presets

Reels and Shorts 1080×1920, YouTube 4K 3840×2160, Square 1080×1080, plus `custom`. A
source that is not already the output's aspect gets a centre **cover** fit — scale until
it covers both axes, crop the overflow symmetrically. Cover rather than contain, because
a Reel with letterbox bars is a bug report and because the caption layout is computed for
the full target canvas.

### NVENC

`RENDER_VIDEO_ENCODER=h264_nvenc` swaps the encoder and nothing else — same filter
graph, same overlay frames. Off by default; `RR-04 §P2.16` puts the evaluation after
cloud volume passes ~500 output-hours a month.

### Dynamic zoom/reframe crop (B20)

When the manifest's `timemap.keyframes` carries an accepted zoom/reframe item's
curve (decoded and remapped onto the output clock by `@montaj/render-core`'s
`outputCropKeyframesFromTracks`, the same function the browser exporter calls),
`ffmpeg/crop-expr.ts` builds a `crop=w:h:x:y` filter whose `w`/`h`/`x`/`y` are
ffmpeg expressions — nested `if(lt(t, ...), ramp, ...)` chains, one per
dimension, since ffmpeg's expression language has no `lerp`. It runs on the
post-cut (`concat`), pre-`buildFit` video: `t` is already the output clock, and
the crop has to see the whole source before the static cover-fit crop changes
the coordinate space. When a dynamic crop is present, the static cover-fit
crop is **skipped** rather than composed with it — the crop window is treated
as the intended composition (already picked at the project's aspect), and
composing a second, static crop on top of a per-frame-varying one is not
expressible as one `scale`/`crop` pair.

**Known deviation:** only a `"linear"` keyframe segment is exact here; an
`"easeInOutCubic"` segment (the browser path's real cubic, run in TypeScript)
is approximated as linear in the ffmpeg expression — building the cubic in
ffmpeg's expression language is possible (`pow()` exists) but was out of reach
in this pass. `ffmpeg/crop-parity.test.ts` proves the two backends agree using
`"linear"`-only fixtures, which is the honest scope of that guarantee.

## The rasteriser pool

Skia runs on `min(cores − 1, 4)` worker threads, so it overlaps with ffmpeg instead of
taking turns with it. That is the difference between **1.13×** and **2.31×** realtime at
1080p; the whole render now costs about what the encoder alone costs.

```
main thread                              worker threads (min(cores − 1, 4))
  renderFrame → hashCommands               ┌─ Skia → SharedArrayBuffer slot 0
  │  (changed frames only)                 ├─ Skia → slot 1
  ├──── DrawCommand[] ~12 KB ──────────────┤
  │                                        └─ …
  └─ write slot bytes → ffmpeg stdin
        ↑ slot released when the write callback fires
```

Three things are load-bearing, and each is asserted in `src/render/pool.test.ts`:

- **Pixels never cross the thread boundary.** A slot is a `SharedArrayBuffer` allocated
  once and drawn into in place; only the finished command list is sent. A20 measured the
  alternative — an 8.3 MB copy per frame made the render _slower_.
- **The cache decision stays on the main thread.** Layout and the hash cost about
  0.9 ms a frame and decide whether a frame is new, so two thirds of a render never
  reach a worker at all.
- **A slot comes back only when the pipe says the bytes have gone**, counted by
  reference: one for the cache's pin on the current frame, one for every output frame
  written from it.

Memory is `slots × width × height × 4` with `slots = workers × 2` — 66 MB at 1080p,
265 MB at 4K — allocated once, whatever the length of the video.

`RENDER_RASTER_WORKERS=0`, a machine without worker threads, or an image missing
`workers/raster-worker.mjs` all fall back to rasterising inline, with a warning. Same
pixels, A20's speed.

## The frame cache

A caption is on screen for two or three seconds and animates for about three hundred
milliseconds of that; the rest of its frames are pixel-identical, and between captions
the frame is empty. `src/render/frames.ts` hashes the command list `renderFrame`
produced and reuses the previous frame's buffer when the hash matches — **two thirds of
the frames** of the sample project at 1080p, four fifths at 4K.

The cache is exact, not a heuristic: outlining is a pure function of the hashed list, so
two frames that hash the same cannot draw differently.

## Subtitle sidecars

`render.subtitle` writes SRT, VTT, TXT and Markdown, one file per (format × script),
under the same export prefix as the video (`{exportId}.{script}.{ext}`).

The remapping is the whole job. A segment's times are on the **source** clock; a sidecar
sits beside a file whose clock has had every accepted cut removed. Shipping source times
would put every caption progressively later than the picture, by exactly the length of
the cuts before it — the drift D30 exists to prevent. A segment straddling a splice
becomes **two cues**, one either side, because a single cue across the splice would be
on screen over footage that no longer contains its words.

ASS is not written here: `@montaj/ass-exporter` owns it (A18a). A `render.subtitle`
manifest asking for the `ass` format is still refused with a message that says so —
writing the sidecar bytes is entirely `@montaj/ass-exporter`'s job.

`render.video`'s `path: "ass"` is a different question — a _burned-in_ fast path via
`ffmpeg -vf ass=` (libass), bypassing the Skia pipeline below entirely. A18a's parity
gate is the only writer of each style's `assRenderable` flag (D33: a real, measured
pixel-diff against libass, not a hand-set flag), and this service checks it: a request
for a style that has not passed the gate is refused with `render/unsupported-output`
naming which style. A request where every referenced style **has** passed the gate is
refused too, for now, with a different message — the actual libass burn-in (encoder
selection, watermark honesty under THREAT-MODEL T10, audio-replace, alpha output) is
A20/A21 follow-up work, outside `@montaj/ass-exporter`'s own file boundary.

## Parity

D33's browser/cloud parity gate has two tolerance sections:

- **Visual** — `@montaj/ass-exporter`'s parity gate (A18a), covering
  `render-canvaskit` (browser) vs `render-skia-node` (cloud) frames, and
  `render-skia-node` vs libass burn-in. Writes `packages/caption-styles/parity/results.json`.
- **Audio** — `parity/audio-parity.ts` (B10b): for a manifest with
  `audio.strategy: "replace"` (the export carries an `ai.clean` output rather
  than the source's own track), hashes the bytes the browser export path
  would fetch from `sources.cleanedAudioUrl` (`apps/web/lib/export/engine.ts`)
  against the bytes the cloud pipeline would download via
  `manifest.audio.cleanKey` (`src/render/pipeline.ts`), and reports whether
  they match. Both ultimately read the same `audio_cleans` row
  (`apps/api/src/exports/exports.service.ts#resolveAudioClean`), so a mismatch
  means a signed-URL builder or a download helper drifted off that row's
  stored key — the DSP chain itself (`worker_ai.clean`) is out of scope here
  and has its own suite (`apps/worker-ai/tests/test_clean_dsp.py`). Run with
  `pnpm --filter @montaj/render exec vitest run parity` (unit tests) or
  `pnpm --filter @montaj/render run parity:audio` to (re)write this package's
  `parity/results.json` `audio` block.

## Fonts

D33 forbids system fonts, so every face arrives as bytes this process registered.
`RENDER_FONT_DIR` points at a font pack — `.ttf`/`.otf` files plus a `fonts.json` naming
each one's family, weight, slant and scripts — which A18b will fill from R2. With no
pack configured the service falls back to the three OFL subsets bundled with
`@montaj/render-core` **and says so in the log**: layout will be correct and the
typefaces will not be.

## Run

```bash
docker compose up -d                    # Redis and MinIO from the repo root
pnpm --filter @montaj/render dev
```

On a healthy boot:

```json
{ "level": "info", "service": "render", "msg": "render ready — waiting for jobs on render.video" }
```

`ffmpeg` and `ffprobe` must be on `PATH`; the service refuses to start without them, and
refuses a build older than major 6. It is developed and tested against **ffmpeg 9.x**,
which is what the Dockerfile's base image line is checked against.

### Configuration

Everything in CONTRACTS §1 comes from `@montaj/config`'s `loadEnv`. On top of that, the
variables below are **infrastructure sizing and naming** rather than product
configuration — the same distinction `jobs.config.ts` draws for `MONTAJ_QUEUE_PREFIX` —
so they are read from `process.env` directly, none is a secret, and every one has a
working default.

| Variable                      | Default   | What it does                                                 |
| ----------------------------- | --------- | ------------------------------------------------------------ |
| `RENDER_CONCURRENCY`          | `1`       | Parallel renders per pod                                     |
| `RENDER_VIDEO_ENCODER`        | `libx264` | `libx264` or `h264_nvenc`                                    |
| `RENDER_FONT_DIR`             | —         | Font pack directory; unset falls back to the bundled subsets |
| `RENDER_WORK_DIR`             | OS temp   | Scratch space for downloads and the encoder's output         |
| `RENDER_PROGRESS_INTERVAL_MS` | `5000`    | Capped at the queue's heartbeat interval                     |
| `FFMPEG_LOG_LEVEL`            | `error`   | ffmpeg's `-loglevel`                                         |
| `MONTAJ_QUEUE_PREFIX`         | `bull`    | Redis key prefix; must match the API's                       |

## Contracts

`src/queues.ts` mirrors `docs/CONTRACTS.md` §3 and `src/queues.test.ts` parses the API's
own list to prove it has not drifted. `src/policies.ts` mirrors A08b's retry and stall
table the same way — `render.video`'s lock is **ten minutes** because a 4K export of a
long timeline genuinely takes that long, and a lock that expired mid-render would hand
the job to a second worker while the first was still encoding.

The progress callback **is** the heartbeat (`JobsService.recordProgress` promotes a
queued job to running), which is why `RENDER_PROGRESS_INTERVAL_MS` can never be set
above a third of the lock.

Outputs go to R2 under CONTRACTS §6:
`ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}`. Egress is reported as **0**
in `usage`, because R2 charges none (D35) — saying zero is not the same as leaving it
out.

## Performance

**2.31× realtime at 1080p** on a 12-thread desktop; 4.87× at 540p; 0.45× at 4K — against
1.13× at 1080p before the rasteriser pool. The ≥ 2× target is met.
[`BENCHMARK.md`](BENCHMARK.md) has the before/after, the stage split showing that ffmpeg
is now the whole render, and what is left to move.

## Layout

```
src/index.ts            boot: env, tool check, stores, two BullMQ workers
src/config.ts           the deployment knobs above
src/policies.ts         A08b's retry/stall table, mirrored
src/queues.ts           queue names, envelope, payload schemas
src/callbacks.ts        the signed progress/completion client (CONTRACTS §3)
src/storage.ts          CONTRACTS §6 keys and an S3-compatible store
src/subtitles.ts        cues on the output clock, and the four sidecar formats
src/ffmpeg/tools.ts     the boot check and the version floor
src/ffmpeg/probe.ts     ffprobe, including rotated phone recordings
src/ffmpeg/graph.ts     the command line, from a manifest and a timemap
src/ffmpeg/encode.ts    spawn, feed the pipe, report progress
src/render/pipeline.ts  one whole render, dependencies injected
src/render/frames.ts    the frame loop and its cache
src/render/fonts.ts     the font pack, and the fallback that warns
src/render/projection.ts payload → the shapes render-core and timemap want
src/render/watermark.ts  the manifest's mark, in any of four corners
src/testing.ts          the synthetic clip, the sample projection, a fake store
scripts/benchmark.ts    the numbers in BENCHMARK.md
```

## Scripts

| Script                                   | What it does                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm --filter @montaj/render dev`       | run the worker against the local stack                                                      |
| `pnpm --filter @montaj/render build`     | `tsc` to `dist/`                                                                            |
| `pnpm --filter @montaj/render typecheck` | type-check including tests                                                                  |
| `pnpm --filter @montaj/render lint`      | ESLint flat config from `@montaj/config/eslint`                                             |
| `pnpm --filter @montaj/render test`      | Vitest, including the end-to-end render                                                     |
| `pnpm --filter @montaj/render bench`     | the benchmark in `BENCHMARK.md`                                                             |
| `pnpm --filter @montaj/render parity`    | regenerates `parity/results.json` (B20b's crop-window parity gate — see `parity/README.md`) |
