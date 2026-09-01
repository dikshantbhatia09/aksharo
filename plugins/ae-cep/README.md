# After Effects CEP panel

A deliberately minimal After Effects panel: sign-in, WAV mixdown, styled text layers, overlay import, one undo group.

**Status:** placeholder — no code yet. Scaffolded by A01 so the workspace layout
matches `03-architecture/10-build-plan.md` section 1.
**Implemented by:** C05b (panel), C00 (ZXP signing), C10 (installer). See `docs/PLAN.md` for scheduling and blockers.

## Intended stack

| Piece        | Choice                                                  | Why                                 |
| ------------ | ------------------------------------------------------- | ----------------------------------- |
| Runtime      | **CEP 12 + ExtendScript**                               | After Effects has no UXP path (D19) |
| Extension id | `ai.aksharo.ae` (from `PLUGIN_IDS` in `@montaj/config`) |                                     |
| Packaging    | signed ZXP plus an installer                            | Adobe requires a signed ZXP         |
| Scope        | minimal by design; Premiere is the priority surface     | fast-follow, not parity             |

## Notes

CEP panels run Chromium 99. They therefore hold tokens **in memory only** and never
persist credentials — the bridge owns those (THREAT-MODEL T13).

## Before writing code here

1. Check `docs/PLAN.md` — this work package may be blocked on a Wave 0 human item.
2. Read `docs/CONTRACTS.md`; the queue, auth and storage contracts are frozen.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering
   codename and must never appear in a user-visible string, id or installer name.
