# @montaj/render-canvaskit

CanvasKit (Skia WASM) backend for the browser and the desktop app: it executes the
`DrawCommand[]` that `@montaj/render-core` produced, on a WebGL surface where one exists
and on a CPU raster surface otherwise.

**Status:** implemented (A16). **Pins:** `canvaskit-wasm` **0.42.0**, exactly.

It contains no layout. Every coordinate and every glyph position arrives finished, so
the only decisions left are which Skia object to build and in what order to draw —
which is what makes decision D33's parity gate meaningful, because the cloud executor
(A20) makes the same decisions from the same list.

## Using it

```ts
import { CanvasKitBackend, createBrowserSurface } from "@montaj/render-canvaskit";

const backend = await CanvasKitBackend.create({
  locateFile: (file) => `/canvaskit/${file}`, // same-origin: a .wasm cannot be fetched cross-origin
  fonts,                                       // the same FontResource[] the layout used
});

const { surface, backend: kind } = createBrowserSurface(backend.ck, canvasElement);
backend.drawFrame(surface.getCanvas(), commands, { background: "#00000000" });
surface.flush();
```

`kind` is `"webgl"` or `"cpu"`: both are Skia and produce the same pixels, only the
speed differs, which is why the fallback is something to *show* the user rather than to
fail on.

For a still — the golden PNG baselines, a thumbnail, the parity gate:

```ts
const png = backend.renderToPng(commands, { width: 540, height: 960, background: "#1a1a20ff" });
```

## Memory

CanvasKit hands out WASM-heap objects that must be `delete()`d by hand. Every object a
frame creates goes into an `Arena` and the whole arena is released when the frame ends,
so no code path has to remember to free anything and an exception mid-frame still frees.
Typefaces, decoded images and `Font` objects outlive a frame and are freed by
`dispose()`.

A font or an image a command names but the backend does not have is **reported**, not
thrown: `backend.missingResources` lists them after `drawFrame`, so one missing asset
costs one caption rather than the whole preview.

## The browser lane

`e2e/` is a Playwright suite that runs chromium against a static harness: it loads
CanvasKit and the fixture fonts from a local server, executes the committed
`fixtures/baselines/commands.json`, encodes the frame, and compares it against the PNG
that Skia-in-Node drew from the same list. The tolerance is D33's own parity SLO — at
most 1% of pixels off by more than 2/255.

```
pnpm --filter @montaj/render-canvaskit test:e2e
```

Seven frames cover the command surface deliberately rather than prettily: stroked and
shadowed type with a per-word scale, a block box with a karaoke sweep, Tamil with
shrink-to-fit, a gradient shader on glyphs, a backdrop blur, the offset raster copies,
and a shadow-only glow. If a command kind has no frame there, nothing catches a backend
that draws it wrong.

Regenerate the baselines with `pnpm --filter @montaj/render-canvaskit baseline:build`
after a deliberate change, look at the images, and commit them with the change.

## Style previews

`pnpm --filter @montaj/render-canvaskit previews:build` renders one still per system
style into `packages/caption-styles/previews/`, from the same `previewFor` definition the
editor's live tiles animate — so the catalogue picture and the live tile cannot disagree.
A20 replaces the still with an animated WebP; the file names do not change.

## Layout

```
src/arena.ts      per-frame ownership of Skia objects
src/backend.ts    CanvasKitBackend, surfaces, typefaces, images
src/canvaskit.ts  the pinned wasm loader
src/execute.ts    DrawCommand[] → Skia calls (no runtime imports; the browser bundles it alone)
src/frames.ts     which frames the PNG baselines cover, and why
src/testing.ts    baseline command lists and the D33 pixel comparison
e2e/              the chromium parity harness
fixtures/baselines/ the committed PNGs and command lists
```

## Scripts

| Script                                              | What it does                                     |
| --------------------------------------------------- | ------------------------------------------------ |
| `pnpm --filter @montaj/render-canvaskit build`      | `tsc` to `dist/` (CJS) and `dist/esm/` (ESM)     |
| `pnpm --filter @montaj/render-canvaskit test`       | Vitest, including the PNG baseline comparison    |
| `pnpm --filter @montaj/render-canvaskit test:e2e`   | the chromium parity lane                         |
| `pnpm --filter @montaj/render-canvaskit baseline:build` | regenerate `fixtures/baselines/`              |
| `pnpm --filter @montaj/render-canvaskit previews:build` | regenerate the style catalogue previews       |
