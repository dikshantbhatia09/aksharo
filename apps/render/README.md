# @montaj/render

Cloud render service. `@montaj/render-core` produces `DrawCommand[]`,
`@montaj/render-skia-node` (`@napi-rs/canvas`, Skia) rasterises them into RGBA
overlay frames, and ffmpeg overlays and encodes with x264 straight to R2.

There is no headless Chromium and no Remotion in this path (decision D33): the
browser, the desktop app and this service all execute the _same_ draw commands
through a Skia backend, which is what makes the parity gate meaningful.

**Status:** A01 scaffold — consumes `render.video` and completes with a stub
result. The real renderer lands in **A20**.

## Run

```bash
docker compose up -d                    # Redis from the repo root
pnpm --filter @montaj/render dev
```

On a healthy boot:

```json
{ "level": "info", "service": "render", "msg": "render ready — waiting for jobs on render.video" }
```

`RENDER_CONCURRENCY` (default 1) caps parallel renders.

## Contracts

`src/queues.ts` mirrors `docs/CONTRACTS.md` section 3; outputs are written under
`ws/{workspaceId}/p/{projectId}/exports/{exportId}.{ext}` (section 6). Export
manifests carrying the watermark decision and caps are signed by the API (A21)
and verified here before a watermark-free render is produced (THREAT-MODEL T10).
