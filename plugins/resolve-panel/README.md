# DaVinci Resolve Studio panel — Aksharo (C09)

> Aksharo is an independent product that works with DaVinci Resolve. It is not
> made, endorsed, or supported by Blackmagic Design.

A small React panel that docks inside DaVinci Resolve **Studio** as a
Workflow Integration plugin (Studio-only, D24/D65 — DaVinci Resolve **Free**
never loads this panel; Free users get C08's `aksharo_core` script from
Workspace ▸ Scripts instead). The panel has **no Resolve scripting API
dependency of its own** — it talks only to C08's in-Resolve loopback server
(`plugins/resolve/aksharo_core_app/server.py`, JSON-RPC over WebSocket,
ports 47841-47843, bearer from `~/.aksharo/resolve.json`).

**Implemented by:** C09 (this work package). **Depends on:** C08 (the
loopback server + this WP's additions to it: `session.status`,
`transcribe.start`, `passes.list`). **Not in this WP:** C10 (the installer
that copies this panel into Resolve Studio's Workflow Integration plugins
folder — see "Packaging" below for what C10 needs).

## Layout

| Path                                                  | What                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.xml`                                        | Workflow Integration plugin manifest — **schema unconfirmed**, see "Known limitations".                                                                                                                                                                                                           |
| `index.html` / `src/index.tsx`                        | Production entry point; the only files (besides `src/host/workflow-integration.ts`'s real adapter and `src/rpc/wsTransport.ts`) allowed to touch a real host/browser global.                                                                                                                      |
| `src/host/workflow-integration.ts`                    | `WorkflowIntegrationHost` — the seam between this package and Resolve's `WorkflowIntegration` host, mirroring C05a's `PremiereHost`. `MockWorkflowIntegrationHost` backs every test; the real adapter throws "unverified" for every method (no Resolve Studio install exists on this build host). |
| `src/rpc/`                                            | JSON-RPC client (`client.ts`), discover-and-connect orchestration (`connect.ts`), the loopback protocol types (`protocol.ts`), and the one real-`WebSocket` transport (`wsTransport.ts`, excluded from the coverage gate like `index.tsx`).                                                       |
| `src/auth/session.ts`                                 | Sign-in state **mirrored** from the script's own bridge session (`session.status`) — this panel never runs a device-code flow itself.                                                                                                                                                             |
| `src/passes/passes.ts`                                | `passes.list` fetch + accepted-item-id extraction for "Apply in Resolve".                                                                                                                                                                                                                         |
| `src/apply/runApply.ts`                               | Drives `apply.begin`/`apply.step`/`apply.commit`/`apply.abort` on the loopback server.                                                                                                                                                                                                            |
| `src/ui/`                                             | React components (`App.tsx` orchestrates connection/session/timeline/passes state) + a local copy of `packages/ui`'s design tokens (see "Shared UI").                                                                                                                                             |
| `src/i18n/strings.ts`, `src/version/manifestCheck.ts` | Local copies of `plugins/premiere-uxp`'s equivalents (see "Shared UI").                                                                                                                                                                                                                           |

## Running

```
pnpm --filter @montaj/resolve-panel build       # esbuild IIFE bundle -> dist/panel.js
pnpm --filter @montaj/resolve-panel typecheck
pnpm --filter @montaj/resolve-panel lint
pnpm --filter @montaj/resolve-panel test        # vitest --maxWorkers=2
pnpm --filter @montaj/resolve-panel test:coverage
```

## Connecting to `aksharo_core`

1. `src/host/workflow-integration.ts`'s `readDiscoveryFile()` reads
   `~/.aksharo/resolve.json` (port, bearer) — real behaviour **unconfirmed**
   pending A00-04 (see "Known limitations").
2. `src/rpc/connect.ts`'s `tryConnect()` builds a transport for that
   port/bearer and returns `undefined` when the script hasn't started yet
   (the panel shows "waiting for the Aksharo script to start" with a retry
   button, `src/ui/App.tsx`).
3. `src/rpc/wsTransport.ts` opens `ws://127.0.0.1:<port>?token=<bearer>` — a
   **query parameter**, not an `Authorization` header, because the browser
   `WebSocket` constructor cannot set request headers on the handshake. This
   WP added a matching `?token=` fallback to
   `plugins/resolve/aksharo_core_app/server.py`'s bearer check
   (`_query_token`); the header form (used by `bridge/client.py`'s real
   Python `websockets` client) remains preferred and is tried first. Flagged
   as a threat-model deviation in the final report — see `docs/THREAT-MODEL.md`
   T11.

## Shared UI

The brief allowed a `plugins/shared-ui` package for code C05b (the After
Effects CEP panel) could reuse. This WP did **not** create one: the pieces
that would move there (`i18n/strings.ts`'s `t()` shape, `version/manifestCheck.ts`,
the `SURFACE`/`TEXT`/`ACCENT`/`SIGNAL` design tokens) are small, dependency-free
files already duplicated once (`plugins/premiere-uxp`'s copies), and a third
near-identical copy did not seem worth a new workspace package's build/lint/test
scaffolding for this pass. If C05b needs the same files, extracting a
`plugins/shared-ui` at that point (three call sites, not two) is a cheap,
low-risk refactor — this package's copies are deliberately close to
`premiere-uxp`'s in shape to make that extraction a near-mechanical move.

## Packaging (C10 dependency)

`tools/release/src/commands/packageResolve.ts` now also stages this panel's
built `dist/` + `manifest.xml` + `index.html` under the release zip's
`panel/` subfolder (placeholder text file if the panel hasn't been built or
`release.config.ts`'s `resolvePanel` is unset), plus
`install-panel.sh`/`install-panel.ps1` installer scripts using
`release.config.ts`'s `resolvePanel.installPaths`. **C10 (the Resolve
installer) had not landed when this WP ran** — those install scripts are
this WP's best guess at where Resolve Studio's "Workflow Integration
Plugins" folder lives per OS (not documented in this repo; see "Known
limitations"). If C10 has landed by the time this is read, confirm its
manifest against `release.config.ts`'s `resolvePanel` entry instead of
guessing again.

## Known limitations / open questions for A00-04 (Gate C)

Nothing here has been run against a real DaVinci Resolve Studio install —
this repo's CI has none, and human spike **A00-04** (`docs/PLAN.md`,
`plugins/resolve/README.md`'s own "Known limitations") has not reported.
Every "unverified" method below is exercised manually per
`docs/GATE-C-CHECKLIST.md`'s new "Studio panel" section, not by this
package's automated tests, which run entirely against
`MockWorkflowIntegrationHost` + a mock JSON-RPC transport.

- **The Workflow Integration `manifest.xml` schema is unconfirmed.** No file
  in this repo documents Blackmagic's exact schema; `manifest.xml` here is
  this WP's best-effort guess (a UUID, a name, a Studio-only flag, one view
  naming an HTML source file) based on the shape Blackmagic's own developer
  material describes at a high level, not a cited, verified reference.
- **Whether `window.workflowIntegration` (or any host bridge global) exists
  at all, and if so what it can do**, is unconfirmed — in particular,
  whether panels get any file-read capability for `readDiscoveryFile()`. If
  they don't, discovery needs a different transport (e.g. the script probing
  a well-known local HTTP endpoint) — see
  `src/host/workflow-integration.ts`'s header comment.
- **The `?token=` query-param bearer fallback** (added to
  `plugins/resolve/aksharo_core_app/server.py` by this WP, since a browser
  `WebSocket` cannot set an `Authorization` header) is a genuine
  brief/threat-model trade-off, not found elsewhere in this repo — flagged
  in the WP report, not resolved here.
- **The Studio-only install path this WP guessed**
  (`release.config.ts`'s `resolvePanel.installPaths`) needs confirmation
  against a real Resolve Studio install and C10's eventual installer.

## Non-affiliation

Aksharo is an independent product that works with DaVinci Resolve. It is not
made, endorsed, or supported by Blackmagic Design. This line ships on every
"Resolve Studio required" guard, the panel footer, and `manifest.xml`'s
description.
