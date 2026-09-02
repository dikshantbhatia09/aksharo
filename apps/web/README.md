# @montaj/web

Next.js 15 (App Router) + React 19 + TypeScript + Tailwind v4 + shadcn/ui. One
codebase for the marketing site and the studio, split by route group.

**Status:** A01 scaffold plus A16's caption canvas and right panel — one
placeholder page per route group, a `/health` route handler, a Playwright smoke
test, and `/studio/styles` mounting the real renderer.

## Route groups

| Group     | URL       | Purpose                                          | Built in |
| --------- | --------- | ------------------------------------------------ | -------- |
| `(site)`  | `/`       | marketing, pricing, styles gallery, downloads    | A24      |
| `(app)`   | `/studio` | authenticated studio: projects, editor, timeline | A13–A17  |
| `(share)` | `/share`  | public review links, comments, approvals         | B15      |
| `(admin)` | `/admin`  | staff console behind its own guard + MFA         | B13      |

Route groups do not affect the URL — `app/(site)/page.tsx` is `/`. They exist so
each surface can own its layout, auth boundary and error handling.

## Run

```bash
pnpm --filter @montaj/web dev     # http://localhost:3000
```

## Styling

Tailwind v4 is configured **in CSS** (`app/globals.css`), not in a JS config
file. shadcn/ui is wired through `components.json` with the `new-york` style and
CSS variables; `components/ui/button.tsx` is the first component and shows the
pattern. A13 replaces these tokens with the real design system and moves the
shared primitives into `@montaj/ui`.

```bash
pnpm --filter @montaj/web exec shadcn@latest add dialog
```

## The caption canvas and the right panel (A16)

`components/editor/canvas/` and `components/editor/panels/` are the editor's
rendering surface, mounted for real by A15.

| Piece                  | What it is                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `use-canvaskit.ts`     | loads CanvasKit and HarfBuzz **once per page** and shares them                 |
| `StylePreviewCanvas`   | one StyleDoc drawn live — a still, or its looping three-second preview         |
| `CaptionStage`         | the proxy `<video>` with the CanvasKit overlay, safe zones and a draggable box |
| `stage-geometry.ts`    | the letterbox fit, the drag maths and the safe-area clamp — pure, unit-tested  |
| `panels/ops.ts`        | every control's change as one `EdgOp` — pure, unit-tested                      |
| `RightPanel`           | the Style, Colors, Look and Anim tabs                                          |

The overlay is drawn by `renderFrame` — the same function the cloud renderer calls —
so what is on screen is what gets burned in. The clock is
`requestVideoFrameCallback`, not `timeupdate`, so the caption drawn belongs to the
frame actually presented; `timeupdate` would be up to 250 ms out and the karaoke
fill would visibly lag. Dragging the caption box emits exactly one
`SetSegmentPosition` per **drop**, never one per pointer move.

`/studio/styles` mounts the panel against the 30 system styles. It is a working
harness, not the editor: A15 replaces the catalogue with the workspace's own from
the API and wires the ops into the real op queue.

### Runtime assets

CanvasKit's `.wasm` and the subset fonts must be served from the app's own origin —
a cross-origin `.wasm` fetch fails under the app's CSP, and a font the layout engine
cannot read is a caption that does not draw. They are **copies**, not committed
files:

```bash
pnpm --filter @montaj/web assets:render   # writes public/canvaskit/ and public/fonts/
```

The Playwright global setup runs it, so the e2e suite fails on a real bug rather
than on a missing 404. A18b replaces the three Noto subsets with the workspace's
real faces served from R2; the URLs the components fetch do not change.

## Tests

```bash
pnpm --filter @montaj/web test              # vitest units (lib/, components/)
pnpm --filter @montaj/web test:e2e:install  # once: download Chromium + WebKit
pnpm --filter @montaj/web test:e2e          # Playwright, chromium + webkit
```

WebKit is a **blocking** lane, not a bonus: Safari is a large share of the Indian
mobile audience and its WebCodecs behaviour differs, so the browser-native export
(A19) has to work there too.

Playwright starts `next dev` itself (`webServer` in `playwright.config.ts`) and
reuses a server you already have running locally.

## Notes

- `next-env.d.ts` is committed here, unlike the Next.js default, so `tsc --noEmit`
  works before a build has ever run — which is what `pnpm typecheck` does in CI.
- `eslint.ignoreDuringBuilds` is on because linting is its own turbo task using
  the shared flat config; the build must not run a second, different pass.
