# Premiere Pro UXP plugin — Aksharo Panel

**Status:** foundation implemented by C05a: manifest v5, bridge sign-in, sequence/in-out
reading, audio mixdown request, panel UI, `/plugins/manifest` version banner. **Apply modes
(C06) landed:** transcript injection, MOGRT captions (+ start-up self-test), alpha overlay, SRT
to bin, accepted cuts/zooms/audio, one transaction per apply with bridge progress reporting, and
a host-id-map re-sync op — see "C06 apply modes" below. **MOGRT authoring (C06b, this update)**
ships the frozen param table, generator, verifier, placeholder `.mogrt`, and the style→param
mapping — see `docs/MOGRT-PARAMS.md`, `docs/MOGRT-STYLE-COVERAGE.md` and
`docs/README-AUTHORING.md`. Installers/Marketplace listing (C10) is still separate.

**Integration note (resolved):** C06 originally hardcoded its own copy of the appendix
param table in `src/apply/types.ts` because C06b (MOGRT authoring) had not landed when C06
was built. The coordinator authorized a follow-up commit on `wp/C06b` to fix this:
`src/apply/types.ts`'s `MOGRT_PARAM_ORDER`/`MogrtParamName` now import from `mogrt/params.ts`
(14 params, append-only) instead of re-declaring them, so there is exactly one source of truth;
`MogrtCaptionParams` gained the optional `BoxFill`/`BoxOpacity` fields to match.
`src/apply/mogrtCaptions.ts`'s `resolveMogrtParams`/`paramsByIndex` needed no changes (they
already iterate `MOGRT_PARAM_ORDER` generically) and its existing tests pass unmodified. Still
open: wiring C06's start-up self-test to `mogrt/verify.ts`'s `verifyMogrtBuffer` (see "Wiring
into C06" in `docs/MOGRT-PARAMS.md`) — a larger behavioural change, not authorized as part of
this fix, and left as a follow-up.

**No Premiere Pro, Adobe UXP Developer Tool, or signed `.ccx` toolchain exist on the build
host**, and the human spike A00-03 (UXP API feasibility on Premiere 25.6+) has not reported.
Every UXP/Premiere-specific call is isolated in `src/host/premiere.ts` behind the
`PremiereHost` interface; `MockPremiereHost` implements it for every test in this package.
`createRealPremiereHost()` is written and typechecks, but every one of its calls
(`requestMixdown`, `readFile`, sequence/selection change events, and every C06 apply-mode call
— `importTranscript`, `insertMogrt`/`setMogrtParams`/`getMogrtParams`, `rippleDelete`,
`setMotionKeyframes`, `importMediaToBin`/`placeOnTrack`, `replaceAudioRange`, `transaction`,
`setItemMetadata`/`getItemMetadata`/`listAksharoItems`/`removeItem`) intentionally throws until
a human runs `docs/GATE-C-CHECKLIST.md` on a real Premiere install — see that file for exactly
what to verify and where.

## C06 apply modes

`src/apply/**` implements the six apply modes against `PremiereHost` (never Premiere/UXP
directly):

- **Transcript injection** (`transcript.ts`): EDG segments/words → a Text-Based Editing
  transcript for the sequence's in/out range; idempotent re-import replaces only the previously
  Aksharo-tagged transcript.
- **MOGRT captions** (`mogrtCaptions.ts`): one caption `.mogrt` instance per visible segment on
  a dedicated track, params resolved by the appendix table (shared with C08b's Text+ macro),
  plus a start-up self-test (`runMogrtSelfTest`) that inserts a scratch instance and confirms
  params round-trip before any real apply runs. Per-word highlight is scoped to computing the
  per-word time windows (`computeWordHighlightWindows`); real keyframing of a MOGRT's own params
  is a Gate-C follow-up (see the checklist).
- **Alpha overlay** (`alphaOverlay.ts`) and **SRT to bin** (`srtBin.ts`): import a downloaded
  render/subtitle file into the project bin (the former also places it on the caption track; the
  latter never touches a track — native captions-track writing stays out of scope).
- **Cuts / zooms / audio** (`cutsZoomsAudio.ts`): accepted cuts ripple-delete the sequence,
  accepted zooms become Motion keyframes from decoded MKF2 rows, and cleaned audio (B10/B10b)
  replaces the source audio for its range. Only `state: "accepted"` items are ever applied.
- **Transactions + re-sync** (`runApply.ts`, `resync.ts`): every apply runs inside one
  `host.transaction`, reporting `apply.begin/step/commit/abort` to the bridge — a thrown step
  rolls the transaction back (host-level) and reports `abort` (bridge-level) with the reason;
  `resync` diffs the host-id map (marker-guid `{aksharo:{projectId, segmentId|itemId, rev}}`)
  against a fetched EDG revision, removing items whose segment is gone and reporting the rest
  `stale`/`upToDate` without re-applying anything on the caller's behalf.

`src/ui/components/ApplyPanel.tsx` is the panel UI: one checkbox + dry-run preview count
(`planApply`) per mode, a mode disabled with a message when e.g. the MOGRT self-test fails, and
an Apply button gated on at least one selection.

## Layout

| Path                                 | What                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                      | UXP manifest v5 (`ai.aksharo.panel`, host `PPRO` min `25.6`)                                                                                                                                  |
| `index.html`                         | Panel entry point (UXP `main`)                                                                                                                                                                |
| `src/host/premiere.ts`               | `PremiereHost` interface, `MockPremiereHost`, `createRealPremiereHost`                                                                                                                        |
| `src/bridge/`                        | Typed JSON-RPC caller over `@montaj/bridge-core`'s protocol, plus the `fetch`-based production transport                                                                                      |
| `src/auth/session.ts`                | Sign-in state machine (device-code/tray-gesture pairing, in-memory session only)                                                                                                              |
| `src/upload/mixdown.ts`              | Mixdown → `media.uploadTicket` → presigned PUT → `POST /transcribe`                                                                                                                           |
| `src/apply/`                         | C06 apply modes: transcript, MOGRT captions, alpha overlay, SRT to bin, cuts/zooms/audio, transaction + progress, re-sync (`types.ts` now imports `MOGRT_PARAM_ORDER` from `mogrt/params.ts`) |
| `src/version/manifestCheck.ts`       | `/plugins/manifest` min/max-version → update banner logic                                                                                                                                     |
| `src/i18n/strings.ts`                | English/Hindi string table (see "i18n" below)                                                                                                                                                 |
| `src/ui/`                            | React panel UI (sign-in, source/transcribe, footer, update banner)                                                                                                                            |
| `scripts/build.mjs`                  | esbuild → single IIFE bundle (`dist/panel.js`) — no `eval`, no dynamic import of remote code, per UXP's JS restrictions                                                                       |
| `docs/GATE-C-CHECKLIST.md`           | Manual verification steps for the first real Premiere run                                                                                                                                     |
| `mogrt/params.ts`                    | The 14 frozen MOGRT params, in order (C06b)                                                                                                                                                   |
| `mogrt/generate.ts`                  | Builds `definition.json`'s contents deterministically from `params.ts`                                                                                                                        |
| `mogrt/zip.ts`                       | Dependency-free STORE-only zip reader/writer                                                                                                                                                  |
| `mogrt/verify.ts`                    | Verifies a `.mogrt`'s `definition.json` against the frozen table; used by CI and (once wired) C06's self-test                                                                                 |
| `mogrt/build-placeholder.ts`         | Builds `mogrt/placeholder.mogrt` (committed; no `.aep`)                                                                                                                                       |
| `mogrt/verify-cli.ts`                | CI entry point: `pnpm --filter @montaj/premiere-uxp verify:mogrt`                                                                                                                             |
| `src/styles/classification-rules.ts` | Mirror of C08b's Resolve `classification_rules.json` rule set (checked against the real file once it exists)                                                                                  |
| `src/styles/mogrt-map.ts`            | Classifies each of the 30 system styles supported/approximate/unsupported using those rules                                                                                                   |
| `src/styles/generate-coverage.ts`    | Writes `docs/MOGRT-STYLE-COVERAGE.md` deterministically                                                                                                                                       |
| `docs/MOGRT-PARAMS.md`               | The frozen param table, documented, plus the `definition.json`/Adobe-EGP distinction                                                                                                          |
| `docs/MOGRT-STYLE-COVERAGE.md`       | Generated: which of the 30 styles map onto the MOGRT (or approximate it) and why the rest don't                                                                                               |
| `docs/README-AUTHORING.md`           | Step-by-step guide for the human who authors the real `.aep` in After Effects (H-25)                                                                                                          |

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
