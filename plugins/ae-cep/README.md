# After Effects CEP plugin — Aksharo Panel

**Status:** implemented by C05b: CEP 12 manifest, bridge sign-in (device-code, same pattern as
C05a's Premiere panel), WAV mixdown via Adobe Media Encoder, styled text layers per segment
(mapped through the shared style classification table, unsupported/approximate styles fall back
to the alpha overlay), alpha overlay import, one undo group per apply, host-id map via a layer
marker comment, and re-sync (a re-apply for the same project replaces only its own previously
tagged layers). ZXP packaging is C00's `sign-zxp`.

**No After Effects, CEP inspector, or signed `.zxp` toolchain exist on this build host.**
Every host call is isolated in `src/host/ae.ts` behind the `AeHost` interface; `MockAeHost`
implements it for every test in this package. `createRealAeHost()` typechecks but every method
throws until a human runs `docs/GATE-C-CHECKLIST.md` on a real After Effects install — see that
file for exactly what to verify and where. The ExtendScript side (`src/jsx/aksharo.jsx`) is
written to the same unverified-until-Gate-C standard: every AE object-model call it makes is
cited against Adobe's documentation (see `src/host/ae.ts`'s header for the exact URLs), never
invented.

## Layout

| Path                                 | What                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `CSXS/manifest.xml`                  | CEP 12 extension manifest (`ai.aksharo.ae`, host `AEFT`, `RequiredRuntime CSXS 12.0`)                               |
| `index.html`                         | Panel entry point (CEP `MainPath`)                                                                                  |
| `src/host/ae.ts`                     | `AeHost` interface, `MockAeHost`, `createRealAeHost` (Gate-C-gated stub)                                            |
| `src/jsx/aksharo.jsx`                | ExtendScript host functions (ES3 subset — see `eslint.extendscript.mjs`)                                            |
| `src/layers/textLayerSpec.ts`        | Pure layer-spec builder: StyleDoc + segments -> `TextLayerSpec[]` (fonts, sizes, colours, positions in comp pixels) |
| `src/styles/classification-rules.ts` | Hand-copied mirror of C08b's Fusion Text+ capability rules                                                          |
| `src/styles/ae-style-map.ts`         | Classifies every system style for AE text layers (+ a font-bundled check)                                           |
| `src/styles/generate-coverage.ts`    | Writes `docs/AE-STYLE-COVERAGE.md`                                                                                  |
| `src/apply/applyCaptions.ts`         | Chooses styled-text-layers vs. alpha-overlay per style, one undo group, host-id tagging, re-sync                    |
| `src/bridge/`                        | Vendored typed JSON-RPC caller over the bridge protocol, plus the `fetch`-based transport                           |
| `src/auth/session.ts`                | Sign-in state machine (device-code/tray-gesture pairing, in-memory session only)                                    |
| `src/upload/mixdown.ts`              | Mixdown → `media.uploadTicket` → presigned PUT → `POST /transcribe`                                                 |
| `src/i18n/strings.ts`                | English/Hindi string table                                                                                          |
| `src/ui/`                            | React panel UI (sign-in, comp/caption/apply panel, footer)                                                          |
| `scripts/build.mjs`                  | esbuild → single IIFE bundle (`dist/panel.js`)                                                                      |
| `eslint.extendscript.mjs`            | ES3-subset lint rules for `src/jsx/*.jsx` only                                                                      |
| `docs/GATE-C-CHECKLIST.md`           | Manual verification steps for the first real After Effects run                                                      |

## Why `plugins/ae-cep`, not `plugins/after-effects-cep`

The C05b brief's file-boundary line names `plugins/after-effects-cep/**`, but
`docs/CONTRACTS.md` §0 (frozen), `release.config.ts`'s `zxp.pluginDir`, `tools/release/src/cli.ts`,
and the licensing plugin-channel schema (`apps/api/src/licensing/**`, `packages/api-client`) all
already use `plugins/ae-cep` — that directory (with a placeholder `README.md`) was scaffolded by
A01 before this WP started. This package follows the frozen repo convention rather than the
brief's literal path; flagged as a brief/repo conflict in the WP report rather than creating a
second, unwired directory.

## Style classification — reusing C06b's table

`src/styles/classification-rules.ts` hand-copies the same C08b Fusion Text+ rule set C06b's
Premiere MOGRT mapping mirrors (`plugins/premiere-uxp/src/styles/classification-rules.ts`) —
copied, not imported, since this package's file boundary is `plugins/ae-cep/**` only.
`src/styles/ae-style-map.ts` classifies AE styled text layers against the identical rules plus
the identical bundled-font-family gate C06b's own mapping uses, so the same 30 system styles land
in the same buckets: **19 supported, 6 approximate, 5 unsupported** (see
`docs/AE-STYLE-COVERAGE.md`). A style classified unsupported or approximate still reaches
picture — `src/apply/applyCaptions.ts` falls back to the pre-rendered alpha overlay (A20)
whenever a style isn't text-layer-exact.

A "supported" style's background box (when `box.enabled`) is rendered as a solid-colour layer
sized to the text layer's own `sourceRectAtTime` bounds, placed directly behind it — kept
in scope specifically so the reused classification table stays accurate for this
implementation too (a "supported" style that silently dropped its box would be misleading).

## Sign-in and session storage

Same pattern as C05a's Premiere panel: THREAT-MODEL.md T13 ("panels hold tokens in memory
only") governs `src/auth/session.ts`. CEP panels are Chromium 99 — `window.localStorage` exists
but is deliberately never used for the session; a panel reload signs the user out.

## Commands

```
pnpm --filter @montaj/ae-cep build
pnpm --filter @montaj/ae-cep test
pnpm --filter @montaj/ae-cep lint
pnpm --filter @montaj/ae-cep lint:jsx
pnpm --filter @montaj/ae-cep typecheck
pnpm --filter @montaj/ae-cep generate:style-coverage
pnpm release sign-zxp --dry-run
```

## Naming

Product name (D65): **"Aksharo Panel"** (footer shortens the full "works with Adobe Premiere
Pro and Adobe After Effects" line to the After Effects half, since that's the only host this
panel runs in), non-affiliation line present (`src/ui/components/Footer.tsx`). Extension bundle
id `ai.aksharo.ae` from `@montaj/config`'s `PLUGIN_IDS.afterEffectsCep`. The engineering
codename never appears in any user-visible string or id.

## Before writing more code here

1. Check `docs/PLAN.md` — installers/Marketplace listing (C10) and real icons are separate
   follow-up work.
2. Read `docs/CONTRACTS.md` and `docs/THREAT-MODEL.md` T11–T14 before touching sign-in, the
   bridge client, or session storage.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering codename and must
   never appear in a user-visible string, id, or installer name.
