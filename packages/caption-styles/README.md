# @montaj/caption-styles

The StyleDoc v2 schema, the style naming rule (decision D64) and the system style
catalogue.

**Status:** schema and naming rule landed by A02; A16 drew the remaining 23 styles, so
all 30 entries in `styles/registry.json` now have a document and a preview.
**Next:** A18a's parity gate writes the parity flags.

## StyleDoc v2

A style is one JSON document — `styles/<id>.json` — validated by `StyleDocSchema`
(`07 §Caption style schema`, F-305). `render-core` reads it, computes layout once from
bundled subset fonts and emits `DrawCommand[]` (D33); `ass-exporter` reads the same
document when a style is exportable as an `.ass` sidecar.

| Field                                                                    | What it holds                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `id`, `name`                                                             | kebab-case id and display name, both bound by the naming rule below        |
| `version`                                                                | StyleDoc schema generation — always `2`; bumped only by a migration        |
| `category`, `minPlan`                                                    | catalogue shelf, and the lowest plan allowed to use the style              |
| `typography`                                                             | family, fallbacks, weight, italic, `sizePct`, `lineHeight`, tracking, case |
| `colors`                                                                 | resting, active (spoken), upcoming and accent colours                      |
| `box`, `stroke`, `shadow`                                                | the plate behind the text, the outline and the drop shadow                 |
| `layout`                                                                 | anchor, normalised position, alignment, width, line and word limits        |
| `animation`                                                              | cue in/out, the word highlight, and whether words appear one at a time     |
| `emphasisPresets`                                                        | named per-word looks that `Segment.emphasis[].presetId` points at          |
| `assRenderable`, `assExportable`, `requiresLayoutMetrics`, `parityScore` | parity flags, written by CI                                                |
| `previewKey`                                                             | R2 key of the preview clip                                                 |

**Everything is relative.** Sizes and positions are fractions or percentages of the
canvas, and lengths that belong to the type (stroke width, shadow offset and blur, box
padding and radius) are percentages of the font size. One document therefore renders the
same at 1080×1920 and at 540×960, and switching aspect ratio does not reposition captions.

### Parity flags are written by CI, never by hand

`assRenderable`, `assExportable`, `requiresLayoutMetrics` and `parityScore` are the output
of A18a's automated SSIM diff across CanvasKit, Skia-Node and libass (D33). Until that gate
runs, a style is assumed to need `render-core` — the schema defaults are
`assRenderable: false`, `assExportable: false`, `requiresLayoutMetrics: true`, and
`parityScore` absent — and the five shipped styles carry exactly those values. Editing them
by hand is a bug: the flags are a measurement, not an opinion.

## The naming rule (D64)

> Styles describe the look, never a person, creator or brand.

"Hormozi Pop" is `punch-pop`; a MrBeast-style is `hype-bold`; no name mirrors a
competitor's. The rule is enforced in three places: `StyleDocSchema` refuses to parse a
document that breaks it, `loadSystemStyles()` therefore refuses to load one, and
`findNamingViolations()` / `assertCompliantStyleName()` are exported so `/styles` can check
an admin's name before saving it.

The deny-list is **data**, at `src/naming/denylist.json`, so the catalogue admin can extend
it without touching code:

```json
{ "version": 1, "tokens": ["hormozi", "mrbeast", "beast", "…"] }
```

Matching is case-insensitive against both `id` and `name`: a token always matches a whole
word, and a token of five characters or more also matches inside a word (so `beastmode-bold`
is caught). Shorter tokens are word-only, which keeps `metallic-sweep` legal.

> **One brief-level conflict, resolved.** The A02 brief asked for a fixture named
> `reels-clean` while also requiring `reels` on the deny-list. "Reels" is a Meta product
> name, so D64 rules it out; the style ships as **`vertical-clean`**, which describes the
> look instead. Flagged for Fable in the A02 report.

## The catalogue

```ts
import { loadSystemStyles, loadStyleRegistry } from "@montaj/caption-styles";

loadSystemStyles(); // 30 validated StyleDocs, ordered by id
loadStyleRegistry(); // the same 30: {id, name, category, status}
```

`styles/registry.json` is the index: 30 ids with their name, category and
`status: "planned" | "shipped"`. Every entry now has a `styles/<id>.json`, and
`src/registry.test.ts` fails if the two ever disagree.

| Style                 | Category  | Look                                                       |
| --------------------- | --------- | ---------------------------------------------------------- |
| `punch-pop`           | bold      | heavy uppercase, yellow active word, thick outline         |
| `hype-bold`           | bold      | condensed all-caps, green highlight, centre screen         |
| `stroke-heavy`        | bold      | very heavy outline, no shadow, nothing behind the type     |
| `bold-drop`           | bold      | drops in from above, one chunk of three words at a time    |
| `impact-shout`        | bold      | one enormous word at a time, bouncing in centre screen     |
| `prism-split`         | bold      | a gradient across the glyphs (needs a shader)              |
| `neon-glow`           | bold      | cyan glow, drawn as a blurred shadow layer                 |
| `vertical-clean`      | clean     | quiet two-line sentence case for vertical video            |
| `outline-only`        | clean     | hollow type: stroke on, fill transparent                   |
| `box-block`           | clean     | square dark plate per line                                 |
| `caption-card`        | clean     | white card, left-aligned, soft shadow                      |
| `karaoke-fill`        | karaoke   | dark plate with a fill that sweeps the word being spoken   |
| `spotlight-word`      | karaoke   | dim line, the spoken word scales up bright                 |
| `podcast-duo`         | podcast   | pill lower-third with a speaker-coloured accent            |
| `word-pop`            | playful   | one word at a time, oversized, bouncing in                 |
| `bubble-soft`         | playful   | white pill per line, dark text, pink highlight             |
| `duo-tone`            | playful   | two-colour read-ahead, blue upcoming, pink active          |
| `gradient-sweep`      | playful   | gradient plate behind the line (needs a shader)            |
| `glitch-shift`        | gaming    | RGB split drawn as two offset copies                       |
| `arcade-pixel`        | gaming    | monospace on a hard purple plate with a hard offset shadow |
| `highlight-marker`    | education | marker highlight behind the word being spoken              |
| `news-ticker`         | education | red lower-left band, small uppercase                       |
| `soft-serif`          | cinematic | slow serif fade, no highlight                              |
| `quote-frame`         | cinematic | centred italic serif on a translucent panel, blur in       |
| `minimal-lower-third` | minimal   | small left-aligned bar, no highlight, nothing shouting     |
| `subtitle-classic`    | minimal   | the broadcast default: white, thin outline, no animation   |
| `whisper-thin`        | minimal   | light, widely tracked, uppercase, slow fade                |
| `liquid-glass`        | minimal   | frosted panel that blurs the video behind it               |
| `typewriter-mono`     | retro     | green monospace revealed a character at a time             |
| `tape-retro`          | retro     | warm monospace on tape brown, chroma warble                |

`punch-pop`, `hype-bold`, `karaoke-fill`, `word-pop` and `minimal-lower-third` are the keys
A03's database seed loads through `loadSystemStyles()`.

Four styles need a drawing capability StyleDoc v2 has no field for — `prism-split` and
`gradient-sweep` a gradient, `liquid-glass` a sampled backdrop blur, `glitch-shift` and
`tape-retro` offset raster passes. That extra ink lives in
`@montaj/render-core`'s `styles/capabilities.ts`, keyed by style id, rather than in a
widened schema; see `stylesWithCapabilities()`.

## How to add a style

1. Add the id to `styles/registry.json` (or flip its `status` to `shipped`).
2. Write `styles/<id>.json`. The file name must equal the `id`, the name must pass the
   deny-list, and the parity flags may be omitted — they default correctly.
3. Leave `parityScore` out; A18a writes it.
4. `pnpm --filter @montaj/caption-styles test` — the catalogue tests validate the new
   document, check it against the registry and re-run the naming rule.

## Scripts

| Script                                               | What it does                                    |
| ---------------------------------------------------- | ----------------------------------------------- |
| `pnpm --filter @montaj/caption-styles build`         | `tsc` to `dist/` with declarations              |
| `pnpm --filter @montaj/caption-styles typecheck`     | type-check including tests                      |
| `pnpm --filter @montaj/caption-styles lint`          | ESLint flat config from `@montaj/config/eslint` |
| `pnpm --filter @montaj/caption-styles test`          | Vitest                                          |
| `pnpm --filter @montaj/caption-styles test:coverage` | Vitest with the 90/85 gate (CONTRACTS §9)       |

## Previews

`previews/<id>.png` is a still of each style, rendered by the real pipeline
(`render-core` layout, CanvasKit raster) from the three-second preview definition the
editor's live tiles animate — so the catalogue picture and the tile cannot disagree.
They are generated, not drawn by hand:

```
pnpm --filter @montaj/render-canvaskit previews:build
```

The build script lives in `@montaj/render-canvaskit` rather than here because this
package must not depend on the renderer: `render-core` depends on *it*.

