# Crop-window parity gate (B20b)

Measures whether the browser exporter's crop-window sampler
(`@montaj/render-core`'s `sampleCropWindow`) and the cloud renderer's ffmpeg
crop expression (`../src/ffmpeg/crop-expr.ts`'s `buildDynamicCropFilter`)
agree — the same check `../src/ffmpeg/crop-parity.test.ts` runs on every
`pnpm test`, turned into a number.

This is **not** the caption _style_ parity gate (`packages/caption-styles/
parity/results.json`, A18a) — that one measures glyph rendering fidelity
(canvas-vs-Skia, ass-vs-Skia) over text/style fixtures and is untouched by
this work package. This one measures agreement on the crop rectangle a
zoom/reframe item produces at a given output instant; nothing here writes to
or reads `packages/caption-styles/parity/results.json`.

## Fixtures

Two, per B20's brief — `crop-fixtures.ts`:

| id                 | what it exercises                                          |
| ------------------ | ---------------------------------------------------------- |
| `cut-plus-zoom`    | a two-keyframe zoom ramp (full frame → punched-in subject) |
| `cut-plus-reframe` | a three-keyframe reframe sweep (two ramp segments)         |

Both fixtures' keyframes are already on the output clock (the same shape
`outputCropKeyframesFromTracks` hands both render paths), so this gate never
touches `@montaj/timemap` itself — only the crop-window sampling the two
backends do independently once they have that curve.

## Gate report

`results.json` (regenerate with `pnpm --filter @montaj/render parity`) is the
current numbers:

| fixture            | samples | max diff (px) | tolerance (px) | status   |
| ------------------ | ------- | ------------- | -------------- | -------- |
| `cut-plus-zoom`    | 6       | ~0.000        | 1.05           | **PASS** |
| `cut-plus-reframe` | 8       | ~0.000        | 1.05           | **PASS** |

Both fixtures currently agree to floating-point noise (< 10⁻¹² px) at every
sampled instant — the two backends run the same linear-interpolation maths,
just in TypeScript and in ffmpeg's expression language respectively. A
non-zero diff would show up here first if the two ever drift (e.g. the known
easing deviation `crop-expr.ts`'s own doc comment already flags: only
`"linear"` segments are exact in the ffmpeg expression, `"easeInOutCubic"` is
approximated as linear there but not in the browser path — neither fixture
above uses an eased segment, so this gate does not currently exercise that
gap; see the B20b final report).

## Regenerating

```
pnpm --filter @montaj/render parity
```

Exits non-zero (and logs which fixture) if any exceeds `maxDiffPxTolerance`.
`run.test.ts` asserts the same tolerance on every `pnpm test` run, so a
regression fails CI before anyone has to read this file.

## Text-fx parity gate (D06b)

A different kind of gate from the one above: not two independently-computed
formulas agreeing on numbers, but two rasterisers — `@montaj/render-canvaskit`
(the browser exporter's own backend) and `@montaj/render-skia-node` (the
cloud renderer's) — drawing the _same_ `DrawCommand[]` and being compared
pixel for pixel. What differs between the two apps is guaranteed identical
by construction (`@montaj/render-core`'s `renderTitleFrame` is the one call
site both `apps/web/lib/export/engine.ts` and `../src/render/frames.ts`
use), so this measures only the two backends' own drawing.

`textfx-fixtures.ts` builds one title per D06 motion preset (`pop`,
`slide-up`, `typewriter`, `underline`, `count-up`, `fade`), each spanning a
6-second clip with no caption on screen, sampled at three instants (entry,
mid-hold, exit). `run-textfx-parity.ts` rasterises every sample with both
backends and reports the worst per-preset pixel-difference ratio.

Regenerate with `pnpm --filter @montaj/render parity:titles`; `results.json`
gains (or updates) its own `titles` key, merge-preserving the same way this
gate's `run.ts` preserves `audio` and vice versa.

| preset       | samples | max diff ratio | tolerance | status   |
| ------------ | ------- | -------------- | --------- | -------- |
| `pop`        | 3       | ~0.0033        | 0.02      | **PASS** |
| `slide-up`   | 3       | ~0.0032        | 0.02      | **PASS** |
| `typewriter` | 3       | ~0.0022        | 0.02      | **PASS** |
| `underline`  | 3       | ~0.0044        | 0.02      | **PASS** |
| `count-up`   | 3       | ~0.0026        | 0.02      | **PASS** |
| `fade`       | 3       | ~0.0032        | 0.02      | **PASS** |

Every preset is well inside D33's own general 1% (`PARITY_MAX_DIFF_RATIO`)
budget; the gate's own tolerance is set at 2% rather than 1% for the same
reason `apps/web/lib/export/engine-parity.test.ts`'s `KNOWN_TEXT_RESIDUALS`
documents for captions — glyph-edge anti-aliasing differs slightly between
CanvasKit and Skia-node, and a title's larger, heavier type shows a touch
more of that residual than a caption's own type does. `run-textfx-parity.test.ts`
asserts the same tolerance on every `pnpm test` run.

## SFX-duck parity gate (D04c)

A second, independent gate lives in `results.json`'s own `sfx` key (never
overwriting `edits`/`audio` above — `run-sfx-parity.ts` reads the file first
and only replaces its key): the browser exporter's `duckGainAt`
(`apps/web/lib/export/engine.ts`) against the cloud renderer's
`buildSfxDuckVolumeExpr` (`../src/ffmpeg/sfx-duck-expr.ts`), evaluated over
three representative `SfxPayload.duck` curves (CONTRACTS §2) — D04a's own
default (`-12dB`/150 ms), an asymmetric shallow/slow duck over two
overlapping speech ranges, and a near-silent duck with a 20 ms ramp. All
three currently agree to floating-point noise (0.0 linear-gain diff against
a `1e-6` tolerance) at every sampled instant — the two implementations run
the same closed-form trapezoid, just in TypeScript and in ffmpeg's
expression language respectively (`sfx-parity.ts`'s `computeSfxParity`,
already proven generically by `sfx-parity.test.ts`).

Regenerate with `pnpm --filter @montaj/render parity:sfx`; `run-sfx-
parity.test.ts` asserts the same tolerance on every `pnpm test` run.

## Audio-mix envelope parity gate (D04e-3)

A different kind of gate again: not two closed-form curves compared
symbolically (the SFX-duck gate above), but the cloud engine's _actual_
rendered audio — real ffmpeg, `../src/ffmpeg/audio-mix.ts`'s
`buildAudioMixPlan`, decoded back to PCM — against a reference signal
computed directly from the closed-form gain/fade/duck arithmetic both
engines are meant to agree on (`run-audio-mix-parity.ts`'s
`referenceMixSamples`, a faithful port of `apps/web/lib/export/
audio-mix.ts`'s `mixSfxCueIntoChunk`; not an import of it — apps do not
import one another in this monorepo, the same rule the SFX-duck gate's own
`browserDuckGainAt` already follows).

`audio-mix-fixtures.ts` is a 6-second clip with three accepted `sfx` cues
over a silent base, per the WP brief: a "ding" with a 50ms fade in/out, a
"whoosh" ducked -12dB under a speech range, and a plain "pop". Both signals
are compared in consecutive 50ms windows, each window's RMS converted to
dBFS first (`audio-mix-parity.ts`'s `computeAudioMixParity`) — the same
scale the brief's own tolerance is stated in.

| metric                   | value                        |
| ------------------------ | ---------------------------- |
| windows compared         | 120 (6s / 50ms)              |
| max deviation            | ~0.05 dB                     |
| tolerance                | 0.5 dB                       |
| every cue window present | **PASS** (all 3, both sides) |

**One real finding, fixed rather than worked around**: the first version of
this gate measured a ~2.8 dB deviation, entirely inside the "whoosh" cue's
duck ramp — nowhere else. The cause was ffmpeg's `volume=eval=frame` filter
recomputing its expression once per _frame_, not per sample; left at
whatever frame size the graph otherwise settled on, the ramp ffmpeg actually
produced was a coarse staircase rather than the smooth trapezoid the
expression describes (and the browser mixer computes per sample). Fixed in
`audio-mix.ts` by forcing a small (64-sample, ~1.3ms) frame right before
every duck filter with `asetnsamples` — a real improvement to the render's
own audio quality, not a parity-gate-specific hack, and something the
D04c SFX-duck gate above could never have caught: it evaluates the ffmpeg
expression symbolically (`expr-eval.ts`), never through a real frame-based
render.

Regenerate with `pnpm --filter @montaj/render parity:audio-mix`;
`run-audio-mix-parity.test.ts` asserts the same tolerance on every
`pnpm test` run.
