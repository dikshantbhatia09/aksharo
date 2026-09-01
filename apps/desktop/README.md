# @montaj/desktop

Electron shell around the web bundle, with the local bridge embedded and the native `montaj-engine` sidecar packaged alongside it.

**Status:** placeholder — no code yet. Scaffolded by A01 so the workspace layout
matches `03-architecture/10-build-plan.md` section 1.
**Implemented by:** C02 (shell), C03a (engine), C10 (installers). See `docs/PLAN.md` for scheduling and blockers.

## Intended stack

| Piece          | Choice                                                                            | Why                              |
| -------------- | --------------------------------------------------------------------------------- | -------------------------------- |
| Shell          | Electron + electron-builder                                                       | one codebase with the web studio |
| Updates        | electron-updater, differential updates, staged rollouts, `stable`/`beta` channels | large app, thin diffs            |
| Deep links     | `aksharo://` (see `BRAND.deepLinkScheme`)                                         | sign-in and open-project handoff |
| Bridge         | the `apps/bridge` code, embedded in-process                                       | one implementation, two shapes   |
| Local engine   | `engine/montaj-engine` sidecar (whisper.cpp, Silero ONNX, deep-filter, ffmpeg)    | no Python on the desktop (D36)   |
| Native surface | tray, native menus, file associations                                             |                                  |

## Notes

Signing and notarisation are **C00** and depend on the procurement items in
`docs/PLAN.md` Wave 0 (A00-01): Apple Developer org and Developer ID, plus a Windows
OV certificate on a cloud HSM. notarytool needs a 24-hour buffer before a release.

The sidecar is version-pinned and hash-checked on launch, and talks over
localhost-only IPC with a token (THREAT-MODEL T22).

## Before writing code here

1. Check `docs/PLAN.md` — this work package may be blocked on a Wave 0 human item.
2. Read `docs/CONTRACTS.md`; the queue, auth and storage contracts are frozen.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering
   codename and must never appear in a user-visible string, id or installer name.
