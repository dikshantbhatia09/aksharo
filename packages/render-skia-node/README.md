# @montaj/render-skia-node

Skia backend for the cloud render service: it executes the `DrawCommand[]` that
`@montaj/render-core` produced on `@napi-rs/canvas` — the same Skia the browser draws
with, built native instead of WASM — and hands back straight RGBA frames for ffmpeg.

**Status:** implemented (A20). **Pins:** `@napi-rs/canvas` **1.0.8**, exactly.

It contains no layout. Every coordinate and every glyph position arrives finished, so
the only decisions left are which Skia call to make and in what order — which is what
makes decision D33's parity gate meaningful, because `@montaj/render-canvaskit` makes
the same decisions from the same list.

## Using it

```ts
import { SkiaNodeBackend } from "@montaj/render-skia-node";

const backend = await SkiaNodeBackend.create({ shaper }); // the layout's own HarfBuzz shaper
await backend.registerImage("watermark", watermarkBytes);

const batch = backend.createBatch({ width: 1080, height: 1920 });
for (const commands of frames) {
  ffmpeg.stdin.write(batch.render(commands)); // one reused 8 MB buffer, not 2,700 of them
}
```

`createBatch` allocates the surface and the output buffer once. A 1080×1920 frame is
8.3 MB of RGBA and a ninety-second Reel is 2,700 frames; allocating per frame is 22 GB
of garbage for one render, which is the whole reason the batch type exists.

Frames come out **straight (unpremultiplied)** RGBA, which is what ffmpeg's
`-pix_fmt rgba` means. `Canvas.data()` is cheaper but premultiplied, and feeding those
bytes to `overlay` darkens every anti-aliased edge.

## Text

Canvas2D has no glyph-id entry point — `fillText` takes a string — so this backend
calls `outlineTextCommands(commands, shaper)` and fills the resulting paths. The
geometry is the same geometry CanvasKit rasterises, from the same face, because both
come from the same HarfBuzz shaping run. **No system font is ever consulted** (D33).

A `text` command that reaches the executor is a caller who forgot the shaper, and it
throws rather than drawing a frame with the captions silently missing.

## The four conversions that have a unit in them

Both backends are Skia, so shapes, gradients, clips and transforms match to the bit —
once these are right. Each is asserted on its own in `src/parity.test.ts`, so a
regression names the conversion rather than a whole frame.

| Thing         | CanvasKit                       | Here                                            |
| ------------- | ------------------------------- | ----------------------------------------------- |
| Gaussian blur | `ImageFilter.MakeBlur(σ)`       | `filter: blur(σpx)` — CSS's argument **is** a σ |
| Drop shadow   | `ImageFilter.MakeDropShadow(σ)` | silhouette + `blur(σpx)`; Canvas2D's own        |
|               |                                 | `shadowBlur` is a **radius**, i.e. 2σ           |
| Stroke joins  | `SkPaint` miter limit **4**     | set explicitly; Canvas2D defaults to 10         |
| Group opacity | `saveLayer(paint)`              | offscreen canvas composited at that alpha       |

The drop shadow is worth a sentence. `ctx.shadowColor`/`shadowBlur` matches CanvasKit
exactly for opaque children, but it draws the source _and_ its shadow in one call, so
the source has to be drawn a second time to sit above a sibling's shadow — and a
translucent layer then composites with itself. That is not a rounding difference: it
made the liquid-glass panel half again as opaque as the browser drew it. Building the
silhouette by hand (colour the layer's alpha, offset, blur, draw, then draw the layer
once) is what `SkImageFilters::DropShadow` does, and `shadowOnly` is then the same
thing minus the last step.

## Parity

`pnpm --filter @montaj/render-skia-node parity` prints the whole table; the test suite
asserts it. Nineteen frames: A16's seven baselines, which cover the _command surface_,
and the four caption fixtures at three instants, which cover the _scripts and the
animation clock_.

Measured on this build (differing = share of pixels whose worst channel is more than
2/255 apart, D33's yardstick):

| Frame | Differing | Frame | Differing | Frame | Differing |
| ------------------------- | --------: | ------------------------- | --------: |
| `punch-pop-hinglish` | 0.565% | `punch-pop-hinglish-80` | **1.10%** |
| `karaoke-fill-hindi` | 0.908% | `punch-pop-hinglish-1500` | 0.565% |
| `vertical-clean-tamil` | 0.570% | `punch-pop-hinglish-2940` | 0.504% |
| `prism-split-english` | 0.881% | `punch-pop-hindi-80` | 0.746% |
| `liquid-glass-english` | 0.862% | `punch-pop-hindi-1500` | 0.581% |
| `glitch-shift-hinglish` | 0.561% | `punch-pop-hindi-2940` | 0.520% |
| **`neon-glow-english`** | **3.31%** | `punch-pop-tamil-80` | 0.809% |
| `punch-pop-english-80` | **1.20%** | `punch-pop-tamil-1500` | 0.673% |
| `punch-pop-english-1500` | 0.522% | `punch-pop-tamil-2940` | 0.340% |
| `punch-pop-english-2940` | 0.538% | **mean, all 19** | **0.83%** |

Sixteen of nineteen are inside D33's 1% SLO and the mean is 0.83%.

**Where the residual comes from, and why it is not a bug.** Everything except text is
bit-exact. CanvasKit draws glyph _ids_ through Skia's glyph cache, which rasterises a
hinted mask per glyph; this backend fills the same outline as a path, with analytic
anti-aliasing. The two differ along the edge of every glyph, and the share of a frame
that _is_ glyph edge grows as the type gets smaller. The two frames over 1% are both
small type — `neon-glow` sets 32 px and then wraps twenty-one runs in a σ≈8 glow that
spreads every edge disagreement into a halo; `punch-pop-tamil-80` is Tamil at the entry
instant, still scaled below its final size. Sub-pixel position quantisation and
whole-frame translation sweeps were both measured and neither helps, which is the
evidence that this is rasteriser difference and not a placement bug.

The alternative would be a second text engine in the cloud, which is the thing D33
exists to prevent. A18a owns the formal gate; `src/parity.test.ts` pins today's numbers
so a regression is visible immediately.

### One deliberate divergence

`render-core` documents a `backdrop` blur as blurring the surface **inside `bounds`**,
and `@montaj/render-canvaskit` writes that as `saveLayer(undefined, bounds, filter, 0)`.
Skia treats `SaveLayerRec`'s bounds as a _hint_ and ignores it, so the browser blurs the
whole frame: measured on 540×960 with a hard edge in the picture, the disagreement is a
σ-wide band right across the frame, hundreds of pixels outside the panel. Every
committed baseline uses a flat ground, where blurring outside the panel changes nothing,
which is why it never showed up in A16's own suite — but over real footage it is the
difference between a frosted caption panel and a fogged video.

This backend clips, i.e. follows the documented contract. Inside `bounds` the two agree
exactly, and `src/parity.test.ts` asserts both halves of that sentence so neither side
can move quietly. Fixing `render-canvaskit` is A16/A18a's call.

## Layout

```
src/executor.ts     DrawCommand[] → Canvas2D calls (the parity surface)
src/backend.ts      SkiaNodeBackend: shaper, images, surfaces, the frame batch
src/errors.ts       SkiaNodeError and its codes
src/version.ts      the pinned @napi-rs/canvas version
src/testing.ts      the parity frames and the D33 pixel comparison
scripts/            the parity table
```

## Scripts

| Script                                             | What it does                                    |
| -------------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/render-skia-node build`     | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/render-skia-node typecheck` | type-check including tests                      |
| `pnpm --filter @montaj/render-skia-node lint`      | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/render-skia-node test`      | Vitest, including the parity suite              |
| `pnpm --filter @montaj/render-skia-node parity`    | print the parity table                          |
