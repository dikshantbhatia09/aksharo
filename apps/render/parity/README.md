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
