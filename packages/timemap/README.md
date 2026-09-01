# @montaj/timemap

One source-time ↔ output-time mapping across accepted cuts, speed changes and freeze
frames (decision **D30**), consumed by `render-core`, the browser exporter, the cloud
renderer, subtitle export, the timeline UI and every NLE applier. Without it captions
drift after autocut.

**Status:** implemented by A02c. Depends on `@montaj/edg` for the frozen `Segment`,
`Word` and `PassItem` shapes (CONTRACTS §2) — types only, erased at build time.

Everything here is **pure**: no I/O, no Node-only imports, no globals. A `TimeMap` is
frozen once built, so the same instance is safe in a React store, a render worker, a
Web Worker and a UXP panel.

## The model

Two clocks, both whole milliseconds (CONTRACTS §0):

- **source** — media time, the clock `Word.s`, `Segment.startMs` and `PassItem.startMs`
  are already on;
- **output** — the edited timeline the viewer sees.

Three edits move one onto the other:

| Edit                             | Source width | Output width   | Meaning                                      |
| -------------------------------- | ------------ | -------------- | -------------------------------------------- |
| `cut {startMs, endMs}`           | positive     | **zero**       | the range is removed                         |
| `speed {startMs, endMs, factor}` | positive     | `width/factor` | retimed; `factor` is source ms per output ms |
| `hold {atMs, durationMs}`        | **zero**     | `durationMs`   | freeze frame: the frame at `atMs` is held    |

`factor` is a playback rate: `2` is twice as fast (half the output), `0.5` is slow
motion (twice the output).

### From edits to spans

`buildTimeMap` resolves the edits and lays the timeline out as an ordered **span list**
that covers `[0, sourceDurationMs]` on the source clock and `[0, outputDurationMs]` on
the output clock, with no gaps on either. Two binary searches over that list — one keyed
on `sourceEnd`, one on `outputStart` — are the whole lookup story.

```
source   0        2000      3000                6000   6500          10000
         |─────────|▓▓▓▓▓▓▓▓▓|───────────────────|▓▓▓▓▓▓|──────────────|
         │ retained│   cut   │      retained     │ cut  │   retained   │
         └────┬────┘         └─────────┬─────────┘      └──────┬───────┘
              │        (removed)       │      (removed)        │
              ▼                        ▼                       ▼
output   0        2000                          5000                 8500
         |─────────|─────────────────────────────|────────────────────|

         outputDurationMs = 10000 − 1000 − 500 = 8500
```

A freeze frame inserts output time at a source instant; a speed range compresses or
stretches it:

```
hold {atMs: 400, durationMs: 200}          speed {200..600, factor: 2}

source  0      400          1000           source  0    200      600   1000
        |───────●────────────|                     |─────|════════|─────|
        │       ┊            │                     │  1× │   2×   │  1× │
output  0      400  600     1200           output  0    200  400        800
        |───────|▒▒▒▒|───────|                     |─────|════|─────────|
                 held
```

## Boundary rules

A cut removes the **half-open** source range `[startMs, endMs)`. The two edges are the
same instant on the output clock — the _splice_ — which is what makes both directions
answerable:

| Query                                            | Answer                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `toOutput(t)`, `t` retained                      | the output instant                                                              |
| `toOutput(cutStart)`                             | the splice                                                                      |
| `toOutput(cutEnd)`                               | the same splice                                                                 |
| `toOutput(t)`, `cutStart < t < cutEnd`           | `null` (and `isInsideCut` is true)                                              |
| `toOutput(t)` where a hold sits                  | the **first** output instant the frame appears at, i.e. the start of the freeze |
| `toOutput(t)`, `t < 0` or `t > sourceDurationMs` | clamped; `locateSource().clamped` says so                                       |
| `toSource(o)`                                    | the source instant **displayed** at `o`                                         |
| `toSource(splice)`                               | `cutEnd` — the frame after the cut                                              |
| `toSource(o)` inside a freeze                    | the held instant; `locateOutput().held` is true                                 |
| `toSource(outputDurationMs)`                     | the source end of the last output-bearing span                                  |
| `toSource(o)` out of range                       | clamped                                                                         |
| `mapRange(a, b)` with `a === b`, or all cut      | `[]`                                                                            |
| `mapRange(a, b)` with `a > b`                    | throws `TimeMapError("invalid-range")`                                          |

`toOutput` is monotonic non-decreasing wherever it is not `null`, and so is `toSource`.

**Round trips.** `toSource(toOutput(s)) === s` exactly for every retained `s` when
nothing is retimed. Retiming quantises — at `4×`, four source milliseconds share one
output millisecond — so there the inverse lands within `ceil(factor/2) + 1` ms; and the
last output millisecond before a splice resolves to the far side of it, because that
instant genuinely shows the post-cut frame. What holds for **every** map is that the
round trip is stable: `toOutput(toSource(toOutput(s))) === toOutput(s)` and
`toSource(toOutput(toSource(o))) === toSource(o)`. All four are property-tested in
`src/properties.test.ts`.

**Total length.** `outputDurationMs === sourceDurationMs − Σcuts + Σholds` exactly when
nothing is retimed, and within half a millisecond of the exact retimed total otherwise —
output positions accumulate as a float and are rounded once per span, so the error never
compounds.

### Conflict resolution

Cuts win, always. `buildTimeMap` normalises before it lays out spans:

1. cuts are clipped to the media, then **merged** where they overlap or touch, so two
   passes proposing the same silence produce one splice;
2. speed ranges are **clipped out of** the cuts; two speed ranges that overlap each
   other are a `TimeMapError("overlapping-speed")` rather than a guess;
3. holds landing strictly inside a cut are dropped — the frame they would freeze is
   gone. A hold on a cut edge is kept and freezes the splice.

Structurally wrong edits (fractional, negative, backwards, `factor <= 0`) throw; edits
that merely run past the end of the media are clipped.

## API

```ts
import { buildTimeMap, cutEdit } from "@montaj/timemap";

const map = buildTimeMap({
  sourceDurationMs: 600_000,
  edits: [cutEdit(2_000, 3_000), cutEdit(6_000, 6_500)],
});

map.toOutput(3_500); //  2_500
map.toOutput(2_500); //  null — inside a cut
map.toSource(2_000); //  3_000 — the frame after the splice
map.outputDurationMs; // 598_500
```

| Member                                                                              | What it does                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `buildTimeMap({sourceDurationMs, edits, fps?, snapCutsToFrames?})`                  | builds the map                                                            |
| `fromAcceptedItems(items, options)`                                                 | builds one from a pass's `PassItem[]` — accepted `cut` items only         |
| `cutsFromItems(items, states?)`                                                     | just the cut edits those items contribute                                 |
| `toOutput(sourceMs)`                                                                | `number \| null`                                                          |
| `toSource(outputMs)`                                                                | `number`, total — the inverse used for scrubbing                          |
| `isInsideCut(sourceMs)`                                                             | `true` exactly when `toOutput` answers `null`                             |
| `locateSource(sourceMs)`                                                            | `{sourceMs, outputMs, insideCut, clamped}` — the splice instead of `null` |
| `locateOutput(outputMs)`                                                            | `{outputMs, sourceMs, held, clamped}`                                     |
| `mapRange(startMs, endMs)`                                                          | `OutputRange[]`, split by cuts only                                       |
| `mapSegment(segment, words?)`                                                       | `{hidden, visibleRanges, outputStartMs, outputEndMs, hiddenWords, words}` |
| `mapWord(word)`                                                                     | `{wid, hidden, ranges}`                                                   |
| `mapKeyframes(keyframes, options?)`                                                 | remapped track with edge keyframes at every splice                        |
| `serialize()` / `parseTimeMap(json)`                                                | versioned JSON round trip                                                 |
| `sourceDurationMs` `outputDurationMs` `fps` `edits` `cuts` `speeds` `holds` `spans` | the frozen state                                                          |
| `snapToFrame(ms, fps, mode?)` `frameDurationMs(fps)` `frameAt(ms, fps)`             | frame helpers                                                             |

### Captions

```ts
const mapped = map.mapSegment(segment, words);
if (!mapped.hidden) draw(mapped.visibleRanges, mapped.outputStartMs);
```

A segment is `hidden` when its author hid it, when no source time survived, or when
every **live** word (tombstoned words are ignored) landed inside a cut — the span may
survive with no text left on it. Partial overlaps are clipped, and a segment straddling
a splice comes back as two ranges. `mapRange` breaks a range **only** at cuts: a speed
change or a freeze frame stays inside one piece, so a caption does not blink off while
the picture is held.

### Keyframes

```ts
map.mapKeyframes(reframeRows, { interpolate: (a, b, r) => lerp(a, b, r) });
```

Keyframes strictly inside a cut are dropped, the rest are remapped, and where a cut sits
between two survivors the curve is **pinned**: one edge keyframe at the cut's start and
one at its end, both landing on the splice. Without them the interpolation would stretch
across the removed time and the zoom or reframe would visibly drift.

```
before   ●───────────────────────▓▓▓▓▓▓───────────────────────●
         k0                      cut                          k1

after    ●───────────────────────●●───────────────────────────●
         k0            edge(cutStart)│           edge(cutEnd) k1
                                     └── both on the splice
```

Without an `interpolate` callback the edges hold their neighbour's value, which is the
right default for an opaque payload. `insertBoundaries: false` turns pinning off.

### Frames

`snapToFrame(ms, fps, mode?)` rounds onto the exact frame grid — 29.97 snaps to the real
33.3667 ms spacing, not a 33 ms approximation — with `"nearest"` (default), `"floor"` or
`"ceil"`. `buildTimeMap({..., fps, snapCutsToFrames: true})` snaps both edges of every
cut to the nearest boundary before merging; a cut shorter than a frame collapses and is
dropped.

### Serialisation

`serialize()` writes `{v: 1, sourceDurationMs, fps?, edits}` with the **normalised**
edits, so `parseTimeMap(map.serialize())` is a fixed point. A document from another `v`
is a `TimeMapError("unsupported-version")`.

### Errors

Every rejection is a `TimeMapError` with a stable `code` — `invalid-duration`,
`invalid-time`, `invalid-range`, `invalid-edit`, `invalid-factor`, `invalid-fps`,
`overlapping-speed`, `missing-fps`, `unsupported-version`, `malformed-document` — and a
`detail` object. `isTimeMapError(error, code?)` is the narrowing guard.

## Performance

Lookups are `O(log n)` in the number of spans, proved deterministically in
`src/search.test.ts` by counting probes through a `Proxy` (never more than
`ceil(log2 n) + 1`). The floor from the work package, measured by
`src/benchmark.test.ts` on a six-hour source with 5,000 cuts (10,001 spans):

| Operation                      | Budget   | Measured |
| ------------------------------ | -------- | -------- |
| 100,000 `toOutput` lookups     | < 100 ms | ~15 ms   |
| 100,000 `toSource` lookups     | < 100 ms | ~16 ms   |
| `buildTimeMap` with 5,000 cuts | —        | ~9 ms    |

Building is linear: boundaries, cuts, speed ranges and holds are all ordered, so three
cursors advance in step and nothing is rescanned.

## Layout

```
src/timemap.ts    buildTimeMap, the TimeMap surface, both lookups, mapRange
src/edits.ts      edit types, validation, conflict resolution
src/spans.ts      the span list
src/search.ts     the two binary searches
src/segments.ts   mapSegment / mapWord
src/keyframes.ts  mapKeyframes
src/serialise.ts  parseTimeMap / stringifyTimeMap
src/pass-items.ts fromAcceptedItems
src/frames.ts     snapToFrame and friends
src/query.ts      the read-only interface the helpers are written against
src/errors.ts     TimeMapError
```

The build emits both formats: CommonJS in `dist/` (the monorepo default, so NestJS and
the BullMQ workers can `require` it) and ES modules in `dist/esm/`, each with its own
declarations. `src/package-exports.test.ts` loads both in a real Node process, compiles
a scratch consumer against the package types, and asserts no `node:` import reached the
output — the browser exporter has to bundle this.

## Scripts

| Script                                        | What it does                                    |
| --------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/timemap build`         | `tsc` to CJS + ESM + declarations               |
| `pnpm --filter @montaj/timemap typecheck`     | type-check sources and tests                    |
| `pnpm --filter @montaj/timemap lint`          | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/timemap test`          | Vitest (builds `dist/` first if it is missing)  |
| `pnpm --filter @montaj/timemap test:coverage` | Vitest with the 90/85 gate from CONTRACTS §9    |
| `pnpm --filter @montaj/timemap bench`         | the benchmark suite on its own                  |
