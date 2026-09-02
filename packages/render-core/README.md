# @montaj/render-core

Backend-independent caption layout. `(StyleDoc, segment, words, time, canvas) → DrawCommand[]`,
computed once in pure TypeScript with HarfBuzz-wasm shaping and bundled subset fonts.

**Status:** implemented (A16). Consumed by `@montaj/render-canvaskit` (browser),
`@montaj/render-skia-node` (cloud, A20) and `@montaj/ass-exporter` (A18a).

The single source of layout truth. Every backend consumes the same `DrawCommand[]`,
which is what makes decision D33's parity gate meaningful: if the browser and the
cloud disagree, the disagreement is in a rasteriser, never in a second layout engine.

## Using it

```ts
import { animate, createFontRegistry, createHarfBuzzShaper, layoutSegment } from "@montaj/render-core";

const registry = createFontRegistry([
  { id: "inter-700", family: "Inter", weight: 700, italic: false, data: interBytes },
  { id: "noto-deva-700", family: "Noto Sans Devanagari", weight: 700, italic: false, data: devaBytes, scripts: ["devanagari"] },
]);
const shaper = await createHarfBuzzShaper(registry); // the only await in the render path

const layout = layoutSegment({ style, segment, words, canvas, registry, shaper, tMs });
const commands = animate({ layout, style, tMs });
```

For a whole project, `renderFrame({ projection, timemap, catalogue, registry, shaper, outputMs })`
maps output time to source time (`@montaj/timemap`, D30), picks the segments on screen,
resolves each one's effective style and draws them in `seq` order.

## The `DrawCommand` union

Ten kinds, all JSON-serialisable, all in absolute canvas pixels:

| Kind                                | Carries                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| `text`                              | a `GlyphRun` — glyph ids, paired positions, clusters, the source text |
| `rect`, `roundRect`, `path`         | geometry plus an optional fill and stroke                     |
| `image`                             | an `assetId` the host resolves, and a destination rectangle   |
| `group`                             | children composited at an opacity                             |
| `transform`                         | a 3×2 affine matrix applied to children                       |
| `clip`                              | a rect, round-rect or path clip applied to children           |
| `shadow`                            | a Gaussian drop shadow layer around children                  |
| `blur`                              | a Gaussian blur of children, or of the **backdrop** behind them |

Fills and strokes take a `Paint`: `solid`, `linear-gradient` or `radial-gradient`.
A backend that cannot draw glyph ids (any Canvas2D surface) calls
`outlineTextCommands(commands, shaper)` and gets the same geometry as paths.

## Layout

**Shaping.** HarfBuzz-wasm (`harfbuzzjs`, pinned) shapes each word at the font's own
upem, in integers, and the scale to pixels happens afterwards in double precision.
HarfBuzz's integer arithmetic is identical on every platform, so two machines produce
the same glyph ids and the same advances — which is the property parity rests on.
Words are shaped individually: it costs cross-word kerning, and it buys exact per-word
boxes for karaoke, per-word animation and `\pos`-ed ASS events.

**Itemisation.** A word is split into maximal same-script runs before a face is chosen,
so a Hinglish caption resolves a Latin face for `video` and a Devanagari one for `बारे`
instead of drawing tofu for whichever came second. Neutral characters join the run to
their left.

**Line breaking**, in this order, and the order is the contract:

1. the segmenter's own greedy character wrap, with the segmenter's own counting rule
   (base code points, combining marks excluded), so layout reproduces the split the
   caption was cut for;
2. **shrink to fit** when the real metrics overflow — the line split does not move;
3. re-wrap by measured width, only once shrinking hits its floor (`MIN_SHRINK`, 0.55);
4. break inside a word at HarfBuzz cluster boundaries, only when one word alone is
   wider than the box — so a Devanagari matra or a Tamil conjunct is never cut in half.

**Anchoring** addresses the ink box, not the taller line-height block, so `box`,
`paddedBox` and the safe-area clamp all talk about the same rectangle.

## Sizing

A StyleDoc carries no pixels. Type size, caption position and the safe-area margin are
percentages of the **canvas height**; stroke width, shadow offset and blur, box padding
and radius are percentages of the **font size**. One document therefore renders
identically at 1080×1920 and at the 540×960 proxy — the property that makes the preview
trustworthy. Every conversion goes through `units.ts`.

## Animation

`animate` is a pure function of `tMs`: no clock, no random source, no state from the
previous frame. Entry and exit animations, per-word highlights (colour, scale, box,
underline, karaoke fill, glow), emphasis presets and the typewriter reveal are all
derived from the time alone, which is what lets a scrub land on exactly the frame an
export produces.

Two deliberate approximations, both documented at their call sites: an emphasis preset's
`weight` is drawn as a faux bold (a hairline stroke) because the face was resolved at
layout time, and the karaoke fill sweeps continuously rather than snapping to cluster
boundaries.

## Fonts

`FontRegistry` is the only way in. A host registers bytes it already has — A18b fetches
the subset faces from R2, the desktop app reads them from disk — and resolution goes
family → the style's fallbacks → any face declaring the run's script → anything that
covers the code points. System fonts are never used (D33).

`fixtures/fonts/` holds three OFL-licensed Noto subsets **for tests only**; see the
README there for provenance and licences.

## Layout

```
src/animate/     easing curves and animate()
src/commands/    the DrawCommand union, constructors, golden hashes, glyph outlining
src/fonts/       the registry, the Shaper interface and the HarfBuzz implementation
src/frame/       style and text resolution, renderFrame()
src/layout/      itemisation, wrapping, layoutSegment()
src/styles/      per-style capability notes and the three-second previews
src/testing.ts   fixture fonts and caption fixtures (`@montaj/render-core/testing`)
fixtures/        the fixture fonts and the committed goldens
```

## Goldens

`fixtures/goldens/` holds a hash for every (style × fixture × instant) — 30 × 4 × 3 —
and the full command list for each fixture at 1500 ms. A hash that moves is a change to
the pixels every backend will draw: regenerate with

```
pnpm --filter @montaj/render-core golden:build
```

read the diff, and commit the reason with it.

## Scripts

| Script                                         | What it does                                    |
| ---------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/render-core build`      | `tsc` to `dist/` (CJS) and `dist/esm/` (ESM)    |
| `pnpm --filter @montaj/render-core typecheck`  | type-check including tests                      |
| `pnpm --filter @montaj/render-core lint`       | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/render-core test`       | Vitest, including the golden and benchmark suites |
| `pnpm --filter @montaj/render-core golden:build` | regenerate `fixtures/goldens/`                |
