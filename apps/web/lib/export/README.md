# `apps/web/lib/export` — browser-native export (A19)

WebCodecs decode/encode with Mediabunny muxing, CanvasKit caption compositing from the
server-signed render manifest, timemap-applied cuts, audio passthrough or cleaned-track
replacement, watermark, progress and cancellation, a File System Access or in-memory
sink. `apps/web/components/editor/export/**` is the dialog that drives it from A15's
editor shell.

**Status:** implemented (A19); A21b integration + throughput/parity/audio/HDR follow-ups implemented (A19b);
offscreen WebGL surface + hardware-encoder policy + splice fades implemented (A19c).

## Pipeline

```
POST /projects/{id}/exports          probe.ts + manifest.ts
        │  (signed RenderManifest, browser path)
        ▼
sanityCheckManifest                  manifest.ts — schema + expiry + caps, NOT a
        │                            signature check (see Deviations)
        ▼
timeMapFromManifest                  timemap-adapter.ts → @montaj/timemap
        │
        ▼
runExport (engine.ts)
  Input/CanvasSink (Mediabunny)  →  decode the source, cover-fit to output size
  renderFrame (render-core)     →  DrawCommand[] per output ms, watermark included
  CanvasKitBackend.renderToPng  →  rasterise the caption layer
  createImageBitmap + drawImage →  composite onto the decode canvas
  CanvasSource.add              →  encode (VideoEncoder) + mux
  audio: decideAudioStrategy    →  copy / encode / polyfill / cloud-required
        │
        ▼
POST /exports/manifests/{id}/complete   manifest.ts
```

`engine.ts` is deliberately free of `postMessage` plumbing so it is unit-testable and
so the Playwright suite can call it directly on the main thread (`export-harness`).
`engine.worker.ts` is the thin Web Worker wrapper the brief asks for; `worker-client.ts`
is its main-thread counterpart.

## Browser support matrix (as implemented)

| Capability                    | Chromium (desktop)    | WebKit / Safari                                                          | Notes                                        |
| ----------------------------- | --------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `VideoEncoder`/`VideoDecoder` | yes                   | no (as of this build)                                                    | `probe.ts` walks `avc1.640034→4d0034→42e01f` |
| `AudioEncoder` AAC            | yes                   | no                                                                       | decides `decideAudioStrategy`'s tree         |
| `showSaveFilePicker` (FSA)    | yes (desktop)         | no                                                                       | falls back to an in-memory `Blob`            |
| `OffscreenCanvas`             | yes                   | yes                                                                      | required by `isBrowserExportEligible`        |
| Mobile (any engine)           | cloud always          | cloud always                                                             | D34; `isMobile` in the capability request    |
| Result                        | browser path eligible | `isBrowserExportEligible` false → dialog sends `mode:"cloud"` explicitly | verified by `e2e/export-fallback.spec.ts`    |

## Deviations from the brief (report these, do not silently resolve)

1. **No client-side manifest signature verification.** The brief asked for "verify
   signature locally (public key from config)". `@montaj/render-manifest` signs with a
   **symmetric** HMAC-SHA256 over `INTERNAL_CALLBACK_SECRET` (see its own README), not
   an asymmetric keypair — there is no public key, in this codebase or in principle, a
   browser could hold without exposing the secret. `apps/api/src/exports/README.md`
   already refused an ES256/JWKS endpoint for the same reason. `sanityCheckManifest`
   does the part that is actually available to an untrusted client: schema parse
   against the exact v1 shape, expiry/clock-skew, and `capViolations` against the
   signed `caps`. Cryptographic authenticity is re-checked server-side at `POST
/exports/manifests/{id}/complete`, which spends the manifest's single-use nonce.
2. **The raw source bucket has no client-reachable signed URL.** `RenderManifest.source`
   can name `bucket: "raw"` (the full-quality S3 original), but the only endpoint this
   work package's boundary can call, `GET /projects/{id}/media/{id}/urls`, returns a
   signed URL for the **derived** proxy only (`MediaUrls.proxy`). `ExportButton.tsx`'s
   `resolveSourceUrl` always uses the proxy and documents the quality trade-off inline.
   Fixing this needs a small addition to `apps/api`/`@montaj/api-client` outside this
   package's file boundary.
3. **No client-reachable endpoint for a watermark asset's bytes.** `GET
/workspaces/{id}/brand-assets` (`BrandAssetDto`) lists an asset's id but not a URL to
   read it. `runExport` therefore takes an injectable `fetchWatermarkAsset` and, when
   the manifest carries a watermark but no fetcher is supplied, **refuses the render
   outright** rather than silently shipping an unwatermarked video — fail closed, on the
   theory that "drew it without the watermark" is indistinguishable from "removed the
   watermark", which the client must never do. A Free-tier export whose signup gift and
   ₹9 pass are both spent cannot complete end to end in this build until that endpoint
   exists; the e2e chromium test therefore uses a fresh account (unconsumed signup gift,
   `manifest.watermark === null`) to exercise the rest of the pipeline for real.
4. **`@montaj/ass-exporter` is not implemented.** Its own `README.md`/`PACKAGE_INFO`
   still mark it A01's placeholder (`implemented: false`) as of this branch, despite the
   brief expecting it. `subtitles.ts` reports `assExportUnavailableReason()` and the
   dialog greys the ASS checkbox out with that reason rather than throwing at export
   time or silently omitting the option.
5. **Cover-fit source scaling is Mediabunny's own `CanvasSink({fit:"cover"})`, not
   `@montaj/render-manifest`'s `coverScaleCrop`.** The two should agree pixel-for-pixel
   for a centred cover fit, but this was not proven bit-for-bit in this pass — an open
   question for a follow-up parity test.
6. **File System Access streaming does not work through the dedicated Worker path.**
   `showSaveFilePicker` is unavailable inside a dedicated worker (main-thread-only,
   requires a user gesture); `worker-client.ts` documents this — a run dispatched
   through `engine.worker.ts` currently falls back to the in-memory sink even when FSA
   is supported. FSA streaming does work when `runExport` is called on the main thread,
   which is what the Playwright e2e test exercises (`preferFileSystemAccess: false`
   there only because Playwright cannot answer a native file picker dialog, not because
   the path is broken). Transferring a pre-obtained `FileSystemFileHandle` into the
   worker is the fix.
7. **Cleaned/cut audio is not re-encoded from a sample source.** The audio decision
   tree (`audio-strategy.ts`) correctly chooses "encode" or "polyfill" for modified
   audio (cuts, or `audio.strategy === "replace"`), and `engine.ts` creates the right
   `AudioBufferSource`/codec — but wiring the retained source ranges (or the cleaned
   track) through a decoder into that source, with the brief's 5 ms splice fades, is not
   connected in this pass. The packet-copy path (unmodified audio — the common case for
   a fresh export) is fully implemented and covered by the e2e test.
8. **`@montaj/render-manifest`'s barrel pulls in `node:crypto` for the browser bundle.**
   Its signing code (`signature.ts`, server-only) is exported from the same `index.ts`
   as the schema/cap-checking helpers this package actually uses client-side; Next's
   webpack config needed a `NormalModuleReplacementPlugin` rewriting `node:*` specifiers
   to their bare form (`next.config.ts`) so the existing `crypto: false` fallback could
   apply — `resolve.fallback`/`resolve.alias` alone do not intercept the `node:` URI
   scheme. A follow-up isomorphic split of the package (schema/caps vs. signing) would
   make this unnecessary.
9. **HDR tone-mapping is not implemented.** The brief calls for "HDR sources tone-mapped
   via a 3D LUT shader in CanvasKit with a notice." Out of reach in this pass; an HDR
   source currently renders without tone-mapping and without a notice. Flagged as an
   open item.
10. **File boundary note.** The brief's own on-disk copy (`A19-browser-export.md`) scopes
    this work to `apps/web/lib/export/**`, `apps/web/components/editor/export/**` and
    root `CHANGELOG.md`; the orchestrator's task description separately referenced a
    `packages/exporter-browser` package that does not exist anywhere in this repository
    (no A01 placeholder, no README, not scoped in the on-disk brief's "File boundaries"
    section). Followed the on-disk brief. Two small, necessary integration edits fall
    outside that literal boundary and are called out per-file above: `editor-client.tsx`
    (mounting `ExportButton`), `next.config.ts` (the `node:crypto` build fix), and the
    new `app/(app)/export-harness/page.tsx` (a Playwright-only driver page, unlinked
    from any navigation, mirroring `app/(app)/studio/styles`'s existing harness-page
    convention).

## A19b (after A21b landed)

A21b (`cfa5485`, merged onto `wp/A19` by cherry-pick — it had landed on `wp/A21`, not
yet on `main`, when this pass started; see the final report) closed the raw-source and
watermark-asset gaps A19 reported, and tightened `decision.ts`'s browser eligibility to
require real H.264 + audio capability at every resolution. This pass:

1. **Consumes `sources`.** `endpoints.ts`'s `ExportSources` and `manifest.ts`'s
   `refreshExportSources` wrap the new `sources: {rawUrl, proxyUrl?, watermarkUrl?}` and
   `GET /exports/manifests/{id}/sources`. `use-export-dialog.ts` decodes `rawUrl` (the
   ORIGINAL media) as the primary source, falls back to `proxyUrl`, and fetches
   `watermarkUrl` directly for `fetchWatermarkAsset` — `ExportButton.tsx`'s old
   proxy-only media-urls workaround is gone entirely.
2. **Raw pixel readback.** `engine.ts` no longer round-trips the caption layer through
   `renderToPng`/`createImageBitmap(Blob)` (PNG encode + decode, per frame). It now
   keeps one `MakeSurface` raster surface and one scratch 2D canvas alive for the whole
   export, and per frame: `drawFrame` → `flush` → `readPixels` → `putImageData` (
   synchronous, no bitmap allocation) → `drawImage` (so the browser's own compositor
   does the alpha blending over the decoded frame, not this code). Measured **0.12×
   realtime** at 1080p on chromium in this sandbox — see "Throughput" below for why
   that number is not the whole story.
3. **`coverScaleCrop` for the cover fit.** `engine.ts` calls `@montaj/render-manifest`'s
   own `coverScaleCrop` against the source's real display dimensions
   (`InputVideoTrack.getDisplayWidth/Height`) and converts its target-space crop
   rectangle back to source space for Mediabunny's `CanvasSink({crop, fit: "fill"})` —
   the same pixel-exact scale+crop the cloud renderer's ffmpeg pair uses, not
   Mediabunny's own `fit: "cover"` heuristic.
4. **Parity check against `render-skia-node`.** `engine-parity.test.ts` (new) renders
   `@montaj/render-canvaskit`'s own `BASELINE_FRAMES` through the _exact_ compositing
   path `engine.ts` uses (persistent surface, `drawFrame`, `readPixels` — no PNG) and
   diffs the result against `@montaj/render-skia-node`'s `SkiaNodeBackend` with decision
   D33's own yardstick (`comparePixels`, `PARITY_MAX_DIFF_RATIO`). All eight baseline
   frames pass within tolerance (`neon-glow-english`'s small-type glyph-edge residual
   budgeted the same way the existing `render-skia-node` suite already budgets it).
   `@montaj/render-skia-node` and `canvaskit-wasm` are `apps/web` devDependencies for
   this test only — never bundled into the browser (Node-only, `@napi-rs/canvas`).
5. **Real audio re-encode for the common case; cloud for the rest.** `engine.ts` now
   computes `retainedSourceRangesMs` (the complement of the manifest's `cut` edits) and
   feeds `AudioSampleSink`-decoded samples for each retained range into
   `AudioBufferSource.add` in order — concatenating them removes exactly the cut ranges,
   with no gap, exactly matching the video timeline. Two cases still route to the cloud
   with a documented `Error` reason rather than a silent failure: `audio.strategy ===
"replace"` (A21b's `sources` still has no signed URL for the cleaned track's bytes —
   the same gap class as the raw/watermark sources A19 reported, not yet closed) and any
   `speed`/`hold` edit (needs a resampled rate this pass does not implement). The 5 ms
   splice-fade the brief asks for is still not applied — an open item.
6. **HDR routes to the cloud automatically.** `decision.ts`'s own `isHdrSource` check
   (A21b) refuses the browser path before a manifest is ever issued, so nothing in
   `apps/web/lib/export` needs to special-case it — the dialog's existing
   `manifest === null` → `cloud-offered` branch already covers it. The 3D LUT
   tone-mapping shader the original brief called for is consequently out of scope: an
   HDR source never reaches the browser compositor at all.
7. **B04's `ExportUpsellPanel` mounted inside `WatermarkNotice`.** Exactly at the mount
   point its own header documents — `onCleanManifestReady` re-runs the same video export
   request once a clean path (signup gift, or a paid ₹9 pass) is confirmed available.

### Throughput

0.12× realtime at 1080p/30fps (300 frames, 10 s clip) measured in `e2e/export.spec.ts`
on this sandbox's headless chromium. That is well under the ≥1× target, and two things
are worth separating:

- **This sandbox has no hardware H.264 encoder.** `hardwareAcceleration:
"prefer-hardware"` was tried and throws outright here ("this specific encoder
  configuration ... is not supported in this environment") rather than falling back —
  confirming there genuinely is no hardware path in this environment. `engine.ts` uses
  `"no-preference"` for portability (a real end-user machine without hardware encode
  should degrade gracefully, not throw). A real desktop Chrome with a hardware H.264
  encoder and a GPU-backed CanvasKit surface — the actual target machine ≥1× is scoped
  against — was not available to measure against in this pass.
  - Note also that `MakeSurface` (used for the persistent caption raster surface) is a
    **CPU** raster surface, not a GPU one (`createBrowserSurface`'s `MakeWebGLCanvasSurface`
    is the GPU path, used for the editor's live preview, not exposed as an off-screen
    surface API this package could call into for an export it never puts on screen).
    CanvasKit's CPU raster path is measurably slower than its WebGL path for anything
    non-trivial; wiring the export compositor through an offscreen WebGL surface instead
    is the highest-leverage remaining throughput item, not attempted in this pass.
- **The optimizations that were made are real and measured, not asserted.** Removing
  the PNG round trip and switching `createImageBitmap` for a synchronous
  `putImageData`/`drawImage` pair are both in the diff; `engine-parity.test.ts` proves
  the pixel output did not change. The honest number this pass can report is "0.12× in
  a no-hardware-encode, CPU-raster sandbox"; the ≥1× target is not verified against the
  hardware it is scoped for and is reported as an open item, not claimed as met.

## A19c (GPU surface, hardware-encoder policy, splice fades)

A19b's own "Throughput" section above named the offscreen WebGL surface as the
highest-leverage remaining item and did not attempt it; this pass does.

1. **Offscreen WebGL caption surface.** `engine.ts`'s persistent caption surface is now
   allocated through `@montaj/render-canvaskit`'s new `createExportSurface(ck, width,
height)`, which tries `ck.MakeWebGLCanvasSurface(new OffscreenCanvas(...))` first and
   falls back to the plain CPU raster `MakeSurface` A19b used exclusively. The
   `drawFrame` → `flush` → `readPixels` → `putImageData` → `drawImage` sequence A19b
   built is unchanged — only where the pixels come from differs — so `EngineResult`
   gained a `captionSurfaceBackend: "webgl" | "cpu"` field reporting which one actually
   ran, surfaced by `e2e/export.spec.ts`'s `caption-surface-backend` annotation.
   Parity: `engine-parity.test.ts` gained a check that `createExportSurface`'s fallback
   path (the only one Node can exercise — no `OffscreenCanvas`/WebGL there) produces
   byte-identical pixels to the plain `MakeSurface` call the existing D33 parity suite
   already proves matches `@montaj/render-skia-node`; the GPU path itself is exercised
   for real by `packages/render-canvaskit`'s own browser e2e suite (`createBrowserSurface`,
   the same GPU-first/CPU-fallback logic on the visible canvas) and by this package's own
   `export.spec.ts`, both running in real chromium.
2. **Hardware-encoder capability probe.** `probe.ts#probeHardwareEncoder` asks
   `VideoEncoder.isConfigSupported` for the probe's best H.264 rung with
   `hardwareAcceleration: "prefer-hardware"` specifically (separate from the ladder's
   own hardware/software-blind "is this codec supported at all" check), reported as
   `ExportCapabilityProbe.hardwareEncoder: boolean | null` (`null` only when there is no
   WebCodecs at all) and threaded into `capabilities.hardwareEncoder` for `POST
/exports`. A throw (this sandbox's own behaviour, confirmed by testing — see A19b's
   note above) is caught and reported as `false`, exactly like an explicit
   `supported: false` answer.
3. **Server-side cloud-default policy above 1080p.** `decision.ts`'s `choosePath`: an
   `auto` request at 1080p or larger (`requestedWidth(input) >=
SOFTWARE_ENCODER_CLOUD_DEFAULT_MIN_WIDTH`) now defaults to the cloud when
   `capabilities.hardwareEncoder !== true`, with `SOFTWARE_ENCODER_CLOUD_DEFAULT_REASON`
   in `reasons`. An explicit `mode: "browser"` request still bypasses this (the ruling's
   own carve-out) and instead carries `SOFTWARE_ENCODER_BROWSER_WARNING` in `reasons` so
   the dialog can show warned copy. `ExportDialog.tsx` detects this specific reason (not
   any cloud-offer reason) and shows an "Export in this browser anyway" button, worded
   with `BRAND.name`, that re-issues the same request with `mode: "browser"`.
4. **Throughput measurement procedure (brief §3).** `e2e/export.spec.ts` no longer
   requests `mode: "auto"` — item 3 above means `auto` would now send this sandbox's
   no-hardware-encoder chromium to the cloud, and the test's job is to exercise the real
   pipeline — so it requests `mode: "browser"` explicitly (the dialog's own "browser
   anyway" override) and annotates `hardware-encoder` (from the probe),
   `realtime-multiplier` and `caption-surface-backend` on every run, unconditionally.
   The ≥1× target from A19b's own report stays a _reported_ number, not an assertion;
   the brief's new hard floor — 0.5× — is asserted **only** when the run's own probe
   reports `hardwareEncoder === true`; otherwise the test only asserts forward progress
   (`> 0`), exactly as A19b's version did. Measured in this pass, this sandbox:
   `hardware-encoder: false`, `caption-surface-backend: webgl` (the `OffscreenCanvas`
   `MakeWebGLCanvasSurface` path did engage — headless chromium's software GL
   (SwiftShader/ANGLE) counts as "WebGL available" for CanvasKit's purposes, even with
   no hardware video encoder), `realtime-multiplier: 0.15` (up from A19b's 0.12× CPU-raster
   number, in the same no-hardware-encoder environment — consistent with the WebGL surface
   being faster than CPU raster, but nowhere near ≥1× without a hardware encoder too). The
   0.5× floor is not exercised here because `hardwareEncoder` is `false` in this
   environment, same as A19b's ≥1× target was not; both remain open items against real
   desktop Chrome hardware, which this sandbox cannot provide.
   To reproduce: `pnpm --filter @montaj/web test:e2e -- export.spec.ts --project=chromium`
   and read the `realtime-multiplier`/`caption-surface-backend`/`hardware-encoder`
   annotations from the HTML report (or `--reporter=json` and inspect `annotations` on
   the test result) — the list reporter does not print custom annotations to stdout.
5. **5ms splice fades.** `engine.ts#applySpliceFades`, called from the "encode"/
   "polyfill" audio branch for each chunk `AudioSampleSink` yields: a linear gain ramp
   over the brief's 5ms window at each join `retainedSourceRangesMs` creates between two
   cut-separated retained ranges (A19b explicitly left this out). The outer edges of the
   whole track — the very start of the first retained range, the very end of the last —
   are never faded, because nothing was cut there; only a boundary adjacent to a removed
   range ramps. Unit-tested directly (`engine.test.ts`) against a duck-typed
   `AudioBuffer` stand-in, since Node has no such global.

## Layout

```
types.ts             shared types, the codec ladder, defensive-loop and duration-cap constants
probe.ts              capability probe
audio-strategy.ts      the audio decision tree
endpoints.ts            local POST /projects/{id}/exports + /exports/manifests/{id}/complete descriptors
manifest.ts             request + sanity-check + completion
timemap-adapter.ts       manifest.timemap -> @montaj/timemap
subtitles.ts            SRT/VTT/TXT generation
checksum.ts             sha256 of the finished export
sink.ts                 File System Access vs. in-memory Mediabunny Target
engine.ts               the pipeline itself
engine.test.ts          retainedSourceRangesMs unit tests
engine-parity.test.ts   D33 parity check against @montaj/render-skia-node (A19b)
engine.worker.ts        Web Worker entry point
worker-client.ts        main-thread wrapper around the worker
index.ts                barrel
```

## Scripts

Runs through `apps/web`'s own scripts: `pnpm --filter @montaj/web test`,
`pnpm --filter @montaj/web test:e2e -- export.spec.ts export-fallback.spec.ts`,
`pnpm --filter @montaj/web lint`, `pnpm --filter @montaj/web typecheck`.
