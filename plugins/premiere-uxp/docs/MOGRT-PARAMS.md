# Aksharo caption `.mogrt` param table (C06b)

The Aksharo caption `.mogrt` exposes exactly these 14 Essential Graphics params,
in this order. **The order and the names are frozen**: C06's `setMogrtParams`
resolves a param by `displayName` first, falling back to this index when the
name lookup fails (03-architecture/05-system-architecture.md §6). Reordering,
renaming, or removing a param here is a breaking change to every caller.

Params 0-11 are C06's own appendix table (identical); 12-13 (`BoxFill`,
`BoxOpacity`) were appended after C08b's Resolve rule set landed and this
module's style classifier was made to mirror it exactly — see "Why `BoxFill`/
`BoxOpacity` exist" below. **C06 had not landed when 12-13 were added**, so its
appendix (still 12 params as briefed) simply predates this pair; flagged for
the orchestrator rather than silently changed out from under C06.

If a new capability needs a param that doesn't exist yet, add it **at the end**
(index 14+) and mark the change in the "Changes" section below — never insert
into or reorder the existing 14.

Generated from `mogrt/params.ts` by `generateMogrtDefinition()`
(`mogrt/generate.ts`); the golden fixture is `mogrt/definition.golden.json`.
`mogrt/verify.ts` checks a real `.mogrt`'s `definition.json` against this exact
table, by name and index, and is what C06's start-up self-test should call
before trusting `setMogrtParams` (see "Wiring into C06" below).

| Index | Name              | Type    | Default   | Description                                                                                                      |
| ----- | ----------------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| 0     | `Text`            | text    | `""`      | The cue's caption text for this segment (source text of the AE text layer).                                      |
| 1     | `Font`            | font    | `Inter`   | Font family name; must match a family bundled in `packages/fonts` or installed system-wide.                      |
| 2     | `Size`            | percent | `5`       | Font size as a percentage of the composition height (mirrors StyleDoc `typography.sizePct`).                     |
| 3     | `Colour`          | color   | `#FFFFFF` | Resting fill colour of the text (StyleDoc `colors.text`).                                                        |
| 4     | `StrokeColour`    | color   | `#000000` | Stroke/outline colour (StyleDoc `stroke.color`); ignored when `StrokeWidth` is 0.                                |
| 5     | `StrokeWidth`     | percent | `0`       | Stroke width as a percentage of font size (StyleDoc `stroke.widthPct`); 0 disables the stroke.                   |
| 6     | `ShadowOpacity`   | percent | `0`       | Drop shadow opacity 0-100 (StyleDoc `shadow.opacity` x100); 0 disables the shadow.                               |
| 7     | `PositionY`       | percent | `80`      | Vertical anchor position as a percentage of composition height (StyleDoc `layout.y` x100).                       |
| 8     | `HighlightColour` | color   | `#FFE14D` | Colour applied to the active word/range while it is spoken (StyleDoc `colors.activeText` or `accent`).           |
| 9     | `HighlightStart`  | percent | `0`       | Start of the per-character highlight sweep (0-100 of the cue's character range), driven by the word timeline.    |
| 10    | `HighlightEnd`    | percent | `0`       | End of the per-character highlight sweep (0-100 of the cue's character range).                                   |
| 11    | `StyleId`         | text    | `""`      | The Aksharo style id baked into this instance; read back by the start-up self-test to confirm the param mapping. |
| 12    | `BoxFill`         | color   | `#000000` | Whole-cue background box fill colour (StyleDoc `box.fill`); no visible effect while `BoxOpacity` is 0.           |
| 13    | `BoxOpacity`      | percent | `0`       | Whole-cue background box opacity 0-100 (StyleDoc `box.opacity` x100); 0 hides the box entirely.                  |

## Why `BoxFill`/`BoxOpacity` exist

C08b's Resolve Fusion `Text+` macro has a plain whole-text Background field, so
most `box.enabled` styles (opaque, block/line mode) are Text+-Supported there —
only a per-word box (`box.mode: "word"`) or a translucent/glass box
(`box.opacity < 0.5`) get downgraded. Without an equivalent background param
here, _every_ boxed style would have had to be marked MOGRT-unsupported
regardless of mode or opacity, which is a much larger and less honest gap than
Premiere's real capability: an AE shape/solid layer under the text can do
exactly what Fusion's Background field does. Adding `BoxFill`/`BoxOpacity` at
the end (not reordering) keeps the two plugins' classification rules
comparable — see `src/styles/classification-rules.ts` (the shared rule set,
mirrored from C08b's `classification_rules.json`) and
`docs/MOGRT-STYLE-COVERAGE.md` (19 supported / 6 approximate / 5 unsupported,
matching C08b's own report style-for-style as of commit `704c92b` on
`wp/C08b`).

## `definition.json` — what it is and isn't

A real Adobe `.mogrt` is a zip containing `definition.json` (Adobe's own
Essential-Graphics-panel metadata), a binary After Effects project (`.aep`),
and optional assets. **This package cannot produce or verify Adobe's own
proprietary `definition.json`/EGP binary format** — that requires a real After
Effects install and its own "Export Motion Graphics Template" command, neither
of which exists on this build host (see the repository-wide note in
`README.md`).

What this package generates instead is its **own** sidecar `definition.json`
(schema in `mogrt/schema.ts`), packaged inside the same zip as the eventual
`.aep`. It exists purely so this plugin's code — `setMogrtParams`, the
start-up self-test, `mogrt/verify.ts`, CI — has a small, versioned, testable
source of truth for the param order/names/types/defaults it depends on. The
human authoring the real `.aep` in AE (H-25, `README-AUTHORING.md`) uses this
table as the spec for what to expose in the Essential Graphics panel, in this
order; nothing here claims to be Adobe's binary format.

## Wiring into C06 (not done in this worktree)

C06 (Premiere apply modes) had not landed when this was written — `main` was
still at "Merge wp/C05a" and C06's own brief instructs it to code against its
appendix param table (identical to this one) until C06b lands. The intended
wiring, for whoever implements or extends C06's start-up self-test:

1. Import `verifyMogrtBuffer` from `plugins/premiere-uxp/mogrt/verify.ts`.
2. Read the shipped `.mogrt`'s bytes via the `PremiereHost.readFile` surface.
3. Call `verifyMogrtBuffer(bytes)` (no `allowPlaceholder`, since a shipped
   build must carry a real `.aep`).
4. On `!result.ok`, refuse to insert any MOGRT instance and surface
   `result.issues` in the panel with a clear message, per the brief
   ("start-up self-test ... reads the params back and confirms the mapping
   (or refuses with a clear message)").

## Changes

- 2026-09 (C06b): initial frozen table, 12 params, 0-11.
- 2026-09 (C06b, same WP): appended `BoxFill`, `BoxOpacity` (12-13) after
  mirroring C08b's `classification_rules.json` — see "Why `BoxFill`/`BoxOpacity`
  exist" above.
