# `apps/web/lib/export` — browser-native export (A19)

WebCodecs decode/encode with Mediabunny muxing, CanvasKit caption compositing from the
server-signed render manifest, timemap-applied cuts, audio passthrough or cleaned-track
replacement, watermark, progress and cancellation, a File System Access or in-memory
sink. `apps/web/components/editor/export/**` is the dialog that drives it from A15's
editor shell.

**Status:** implemented (A19).

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
engine.worker.ts        Web Worker entry point
worker-client.ts        main-thread wrapper around the worker
index.ts                barrel
```

## Scripts

Runs through `apps/web`'s own scripts: `pnpm --filter @montaj/web test`,
`pnpm --filter @montaj/web test:e2e -- export.spec.ts export-fallback.spec.ts`,
`pnpm --filter @montaj/web lint`, `pnpm --filter @montaj/web typecheck`.
