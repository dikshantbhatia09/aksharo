# Premiere Pro UXP plugin — Aksharo Panel

**Status:** foundation implemented by C05a: manifest v5, bridge sign-in, sequence/in-out
reading, audio mixdown request, panel UI, `/plugins/manifest` version banner. Apply modes
(transcript injection, MOGRT captions, overlays, SRT to bin) are C06/C06b; installers and
Marketplace listing are C10.

**No Premiere Pro, Adobe UXP Developer Tool, or signed `.ccx` toolchain exist on the build
host**, and the human spike A00-03 (UXP API feasibility on Premiere 25.6+) has not reported.
Every UXP/Premiere-specific call is isolated in `src/host/premiere.ts` behind the
`PremiereHost` interface; `MockPremiereHost` implements it for every test in this package.
`createRealPremiereHost()` is written and typechecks, but several of its calls
(`requestMixdown`, `readFile`, sequence/selection change events) intentionally throw until a
human runs `docs/GATE-C-CHECKLIST.md` on a real Premiere install — see that file for exactly
what to verify and where.

## Layout

| Path                           | What                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`                | UXP manifest v5 (`ai.aksharo.panel`, host `PPRO` min `25.6`)                                                            |
| `index.html`                   | Panel entry point (UXP `main`)                                                                                          |
| `src/host/premiere.ts`         | `PremiereHost` interface, `MockPremiereHost`, `createRealPremiereHost`                                                  |
| `src/bridge/`                  | Typed JSON-RPC caller over `@montaj/bridge-core`'s protocol, plus the `fetch`-based production transport                |
| `src/auth/session.ts`          | Sign-in state machine (device-code/tray-gesture pairing, in-memory session only)                                        |
| `src/upload/mixdown.ts`        | Mixdown → `media.uploadTicket` → presigned PUT → `POST /transcribe`                                                     |
| `src/version/manifestCheck.ts` | `/plugins/manifest` min/max-version → update banner logic                                                               |
| `src/i18n/strings.ts`          | English/Hindi string table (see "i18n" below)                                                                           |
| `src/ui/`                      | React panel UI (sign-in, source/transcribe, footer, update banner)                                                      |
| `scripts/build.mjs`            | esbuild → single IIFE bundle (`dist/panel.js`) — no `eval`, no dynamic import of remote code, per UXP's JS restrictions |
| `docs/GATE-C-CHECKLIST.md`     | Manual verification steps for the first real Premiere run                                                               |

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
