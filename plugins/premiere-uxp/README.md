# Premiere Pro UXP plugin — Aksharo Panel

**Status:** foundation implemented by C05a: manifest v5, bridge sign-in, sequence/in-out
reading, audio mixdown request, panel UI, `/plugins/manifest` version banner. Apply modes
(transcript injection, MOGRT captions, overlays, SRT to bin) are C06/C06b; installers and
Marketplace listing are C10. C06b (this update) ships the MOGRT authoring side: the frozen
param table, generator, verifier, placeholder `.mogrt`, and the style→param mapping — see
`docs/MOGRT-PARAMS.md`, `docs/MOGRT-STYLE-COVERAGE.md` and `docs/README-AUTHORING.md`.

**No Premiere Pro, Adobe UXP Developer Tool, or signed `.ccx` toolchain exist on the build
host**, and the human spike A00-03 (UXP API feasibility on Premiere 25.6+) has not reported.
Every UXP/Premiere-specific call is isolated in `src/host/premiere.ts` behind the
`PremiereHost` interface; `MockPremiereHost` implements it for every test in this package.
`createRealPremiereHost()` is written and typechecks, but several of its calls
(`requestMixdown`, `readFile`, sequence/selection change events) intentionally throw until a
human runs `docs/GATE-C-CHECKLIST.md` on a real Premiere install — see that file for exactly
what to verify and where.

## Layout

| Path                                 | What                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                      | UXP manifest v5 (`ai.aksharo.panel`, host `PPRO` min `25.6`)                                                            |
| `index.html`                         | Panel entry point (UXP `main`)                                                                                          |
| `src/host/premiere.ts`               | `PremiereHost` interface, `MockPremiereHost`, `createRealPremiereHost`                                                  |
| `src/bridge/`                        | Typed JSON-RPC caller over `@montaj/bridge-core`'s protocol, plus the `fetch`-based production transport                |
| `src/auth/session.ts`                | Sign-in state machine (device-code/tray-gesture pairing, in-memory session only)                                        |
| `src/upload/mixdown.ts`              | Mixdown → `media.uploadTicket` → presigned PUT → `POST /transcribe`                                                     |
| `src/version/manifestCheck.ts`       | `/plugins/manifest` min/max-version → update banner logic                                                               |
| `src/i18n/strings.ts`                | English/Hindi string table (see "i18n" below)                                                                           |
| `src/ui/`                            | React panel UI (sign-in, source/transcribe, footer, update banner)                                                      |
| `scripts/build.mjs`                  | esbuild → single IIFE bundle (`dist/panel.js`) — no `eval`, no dynamic import of remote code, per UXP's JS restrictions |
| `docs/GATE-C-CHECKLIST.md`           | Manual verification steps for the first real Premiere run                                                               |
| `mogrt/params.ts`                    | The 14 frozen MOGRT params, in order (C06b)                                                                             |
| `mogrt/generate.ts`                  | Builds `definition.json`'s contents deterministically from `params.ts`                                                  |
| `mogrt/zip.ts`                       | Dependency-free STORE-only zip reader/writer                                                                            |
| `mogrt/verify.ts`                    | Verifies a `.mogrt`'s `definition.json` against the frozen table; used by CI and (once wired) C06's self-test           |
| `mogrt/build-placeholder.ts`         | Builds `mogrt/placeholder.mogrt` (committed; no `.aep`)                                                                 |
| `mogrt/verify-cli.ts`                | CI entry point: `pnpm --filter @montaj/premiere-uxp verify:mogrt`                                                       |
| `src/styles/classification-rules.ts` | Mirror of C08b's Resolve `classification_rules.json` rule set (checked against the real file once it exists)            |
| `src/styles/mogrt-map.ts`            | Classifies each of the 30 system styles supported/approximate/unsupported using those rules                             |
| `src/styles/generate-coverage.ts`    | Writes `docs/MOGRT-STYLE-COVERAGE.md` deterministically                                                                 |
| `docs/MOGRT-PARAMS.md`               | The frozen param table, documented, plus the `definition.json`/Adobe-EGP distinction                                    |
| `docs/MOGRT-STYLE-COVERAGE.md`       | Generated: which of the 30 styles map onto the MOGRT (or approximate it) and why the rest don't                         |
| `docs/README-AUTHORING.md`           | Step-by-step guide for the human who authors the real `.aep` in After Effects (H-25)                                    |

## MOGRT authoring (C06b)

A `.mogrt` is a zip: `definition.json` + a binary After Effects project
(`.aep`) + optional assets. **No After Effects exists on this build host**, so
this package ships everything except the `.aep`: the frozen param table
(`mogrt/params.ts`), a deterministic generator (`mogrt/generate.ts`, golden
fixture `mogrt/definition.golden.json`), a verifier (`mogrt/verify.ts`) that
checks a real `.mogrt`'s `definition.json` against that table by name and
index, and the committed placeholder `mogrt/placeholder.mogrt` (generated
definition + a `PLACEHOLDER.txt` note, no `.aep`, no assets) that CI verifies
via `pnpm --filter @montaj/premiere-uxp verify:mogrt`. `docs/README-AUTHORING.md`
is the exact procedure for the human who builds the `.aep` once a machine with
After Effects is available (H-25); `docs/MOGRT-PARAMS.md` is the frozen spec
they author against.

`src/styles/mogrt-map.ts` classifies every one of the 30 `@montaj/caption-styles`
system styles as supported / approximate / unsupported, applying C08b's shared
`classification_rules.json` (mirrored in `src/styles/classification-rules.ts`,
same rule ids/predicates, reworded reasons for AE/Premiere) plus one
MOGRT-only rule for fonts outside the bundled OFL pack — see
`docs/MOGRT-STYLE-COVERAGE.md` (generated by
`pnpm --filter @montaj/premiere-uxp generate:style-coverage`): **19 supported,
6 approximate, 5 unsupported**, matching C08b's own
`plugins/resolve/docs/RESOLVE-STYLE-COVERAGE.md` counts and per-style buckets
exactly (checked against commit `704c92b` on `wp/C08b`). `mogrt/params.ts`
carries two params (`BoxFill`, `BoxOpacity`, indices 12-13) added specifically
so a whole-cue background box classifies against the real capability gap
(per-word or translucent boxes) rather than being blanket-unsupported here —
see "Why `BoxFill`/`BoxOpacity` exist" in `docs/MOGRT-PARAMS.md`.
`classification-rules.test.ts` and `mogrt-map.test.ts` both check agreement
against C08b's real files once `wp/C08b` is on `main` in this worktree.

## Sign-in and session storage — a brief/threat-model conflict, resolved

The WP brief (C05a) says "session held in UXP secure storage." `docs/THREAT-MODEL.md` T13 and
`03-architecture/12-redesign-decisions.md` D25 both say "panels keep tokens in memory only."
This implementation follows the threat model (frozen doc) and keeps the session in a plain
in-memory field (`SignInSession`, `src/auth/session.ts`) — never in `uxp.storage.secureStorage`,
`localStorage`, or on disk. A panel reload signs the user out; that is intentional. Flagged as
an open conflict in the C05a work-package report rather than silently choosing one side.

## i18n

No shared `packages/i18n` exists in this repo yet (checked before building; B17 — onboarding
language defaults — has not landed one). `src/i18n/strings.ts` is this package's own small
`t(key, vars?)` lookup with English/Hindi tables, deliberately shaped like a future shared
package (flat keys, `{placeholder}` interpolation) so migrating is a rename, not a rewrite.

## Design tokens

This panel does not depend on `@montaj/ui` (Radix + Tailwind + a PostCSS build the UXP
esbuild-IIFE bundle isn't set up to run). `src/ui/tokens.ts` is a small copy of the values in
`packages/ui/src/tokens.ts` (dark surfaces, lime accent, Inter) so a screenshot of this panel
still matches `03-architecture/08-ux-design-system.md` §1/§4.

## Commands

```
pnpm --filter @montaj/premiere-uxp build
pnpm --filter @montaj/premiere-uxp test
pnpm --filter @montaj/premiere-uxp lint
pnpm --filter @montaj/premiere-uxp typecheck
pnpm release package-ccx --dry-run
```

## Naming

Product name (D65): **"Aksharo Panel"**, footer non-affiliation line present
(`src/ui/components/Footer.tsx`). Plugin id `ai.aksharo.panel` from `@montaj/config`'s
`PLUGIN_IDS`. The engineering codename never appears in any user-visible string or id.

## Before writing more code here

1. Check `docs/PLAN.md` — apply modes (C06/C06b) and packaging (C10) are separate work
   packages; this package's `Out of scope` list in the C05a brief is the source of truth.
2. Read `docs/CONTRACTS.md` and `docs/THREAT-MODEL.md` T11–T14 before touching sign-in,
   the bridge client, or session storage.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering codename and must
   never appear in a user-visible string, id, or installer name.
