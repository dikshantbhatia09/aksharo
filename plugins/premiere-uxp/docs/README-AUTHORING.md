# Authoring the Aksharo caption `.mogrt` in After Effects (H-25)

**This is a human task.** No Premiere Pro, no After Effects, and no Adobe UXP
Developer Tool exist on the build host that produced the rest of this work
package, so the `.aep` cannot be authored, exported, or even opened here. This
document is the exact procedure to follow once a machine with a licensed After
Effects install (25.x or the version pinned by `plugins/premiere-uxp/manifest.json`'s
`PPRO` min) is available. Everything this package could produce without AE —
the generated `definition.json`, its schema, the verifier, and the placeholder
`.mogrt` — is already committed; this document only covers the remaining
manual step.

## 1. Prerequisites

- After Effects (matching the Premiere Pro version this plugin targets).
- The bundled font pack installed system-wide: every `.ttf` under
  `packages/fonts/pack/*.ttf` (Inter, Montserrat, Poppins, Playfair Display,
  Roboto Mono, Anton, Bricolage Grotesque, JetBrains Mono, and the Noto Sans
  script families) must be installed on the authoring machine — AE text layers
  resolve fonts by family name from the system font list, not from a bundled
  file. Install all of them, even families this particular MOGRT doesn't use
  yet, so future param additions don't need a second authoring pass.
- `plugins/premiere-uxp/docs/MOGRT-PARAMS.md` open for reference — it is the
  frozen source of truth for what to expose and in what order.

## 2. Build the composition(s)

1. Create two comps, `Aksharo Caption 16x9` (1920x1080) and
   `Aksharo Caption 9x16` (1080x1920), both 30fps, both long enough for a
   single-segment caption (10s is a safe default; duration is driven by the
   Premiere clip once inserted, so this is just an authoring-time placeholder).
2. In each comp, add one text layer named `Caption Text`, and one solid or
   shape layer beneath it named `Caption Box` sized/positioned to sit behind
   the text (a rectangle a little larger than the text's bounding box is
   fine — the exact fit doesn't need to be pixel-perfect since `BoxOpacity`
   defaults to 0, i.e. invisible, for every style that doesn't use it). Do not
   add other layers unless a future param table entry needs one — the frozen
   params above assume exactly one text layer, one background layer, and one
   text animator.

## 3. Per-character highlight (the `HighlightStart`/`HighlightEnd` sweep)

1. On `Caption Text`, add a Text Animator (Animate → Fill Colour is enough for
   the `color`-type styles this MOGRT supports; see
   `docs/MOGRT-STYLE-COVERAGE.md` for exactly which of the 30 system styles map
   here and which don't).
2. Add a Range Selector to that animator.
3. Set the Range Selector's **Start** and **End** properties to be driven by
   two slider controls named exactly `HighlightStart` and `HighlightEnd`
   (Effect → Expression Controls → Slider Control, then link Start/End to them
   via expressions, e.g. `thisComp.layer("Caption Text").effect("HighlightStart")("Slider")`).
   Units: 0-100, mapped to the Range Selector's 0%-100%.
4. Set the animator's Fill Colour to a Color Control named `HighlightColour`.

## 4. Expose the remaining params in the Essential Graphics panel

Open Window → Essential Graphics, target the comp, and drag in controls **in
exactly this order** (see `docs/MOGRT-PARAMS.md` for the full table with
defaults and descriptions) — Premiere resolves params by display name with an
index fallback, so both the order and these exact names matter:

1. `Text` — the `Caption Text` layer's Source Text.
2. `Font` — the `Caption Text` layer's font family (a Font control, or a
   Dropdown if you'd rather constrain it to the bundled families).
3. `Size` — the `Caption Text` layer's font size (as a percentage-of-comp-height
   slider, matching StyleDoc's `sizePct` convention — do not use raw pixels).
4. `Colour` — the `Caption Text` layer's fill colour.
5. `StrokeColour` — the `Caption Text` layer's stroke colour.
6. `StrokeWidth` — the `Caption Text` layer's stroke width (percentage of font
   size; 0 = no stroke, so the stroke can stay enabled in AE and just render
   invisibly for styles with `stroke.enabled: false`).
7. `ShadowOpacity` — the drop shadow layer style's opacity, 0-100.
8. `PositionY` — the `Caption Text` layer's vertical position (percentage of
   comp height).
9. `HighlightColour` — from step 3.
10. `HighlightStart` — from step 3.
11. `HighlightEnd` — from step 3.
12. `StyleId` — a text control, not otherwise wired to anything visual; it
    exists purely so the start-up self-test can read back which style produced
    this instance.
13. `BoxFill` — the `Caption Box` layer's fill colour.
14. `BoxOpacity` — the `Caption Box` layer's opacity (0-100; 0 = fully
    transparent, which is the default and correct for every style whose
    `box.enabled` is false).

Rename each control in the Essential Graphics panel to match the name exactly
(case-sensitive) — this is what `displayName` resolution depends on.

## 5. Export

1. File → Export → Add to Adobe Templates Folder (or Export As Motion
   Graphics Template…).
2. Name the file `aksharo-caption.mogrt` and place it at
   `plugins/premiere-uxp/mogrt/aksharo-caption.mogrt` (this replaces the
   placeholder once it exists — do not delete `placeholder.mogrt` from git
   history, just stop referencing it from the shipped build).
3. Do not include any raw media assets beyond what the comps need — no stock
   footage, no fonts (fonts are a system dependency, not bundled in the zip).

## 6. Verify

From `plugins/premiere-uxp/`:

```
pnpm exec tsx mogrt/verify-cli.ts
```

This currently points at `mogrt/placeholder.mogrt`. Once the real
`aksharo-caption.mogrt` exists, update `mogrt/verify-cli.ts`'s target path (or
call `verifyMogrtBuffer` directly from a small script) and confirm:

- `result.ok === true`
- `result.isPlaceholder === false`
- exactly one `.aep` entry, exactly one `definition.json` entry
- all 14 params present, in order, with the exact names in
  `docs/MOGRT-PARAMS.md`

If the export tool wrote its own `definition.json` (Adobe's EGP format) that
this package's schema doesn't recognise, keep **both**: add this package's
`definition.json` under a different name inside the zip (e.g.
`aksharo-definition.json`) and update `verify.ts`'s entry name accordingly —
do not delete Adobe's own file, Premiere needs it to render the template.

## 7. Update the Gate C checklist

Add a line to `docs/GATE-C-CHECKLIST.md` (owned by C06/C05a) noting the real
`.mogrt` replaced the placeholder and the verifier passed, with the date and
AE version used.
