# Premiere Pro UXP plugin

The Premiere Pro panel: sign-in through the bridge, transcript injection, MOGRT captions, cuts, zooms and audio.

**Status:** placeholder — no code yet. Scaffolded by A01 so the workspace layout
matches `03-architecture/10-build-plan.md` section 1.
**Implemented by:** C05a (foundation), C06 (apply modes), C06b (MOGRT authoring), C10 (packaging). See `docs/PLAN.md` for scheduling and blockers.

## Intended stack

| Piece       | Choice                                                                  | Why                                                                           |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runtime     | **UXP**, manifest v5, `minVersion 25.6.0`                               | CEP is being removed from Premiere; ExtendScript support ends Sept 2026 (D19) |
| UI          | React inside the UXP panel                                              | shares components with the web studio                                         |
| Plugin id   | `ai.aksharo.panel` (from `PLUGIN_IDS` in `@montaj/config`)              | brand, never the codename                                                     |
| Packaging   | `.ccx`, direct download plus a Marketplace listing                      |                                                                               |
| Host bridge | `apps/bridge` over relay, loopback as fallback                          |                                                                               |
| Captions    | MOGRT insert with a documented parameter order and a start-up self-test |                                                                               |

## Notes

**Blocked on a human spike:** A00-03 in `docs/PLAN.md` must first confirm on real
Premiere 26.x that the Transcript JSON schema round-trips, and that MOGRT insert +
parameters, ripple delete, transform keyframes, audio insert, `executeTransaction`
and loopback https/wss on macOS all behave. Nothing here is built before that.

Host ids are stored in marker GUIDs so re-sync survives a user editing the sequence.

## Before writing code here

1. Check `docs/PLAN.md` — this work package may be blocked on a Wave 0 human item.
2. Read `docs/CONTRACTS.md`; the queue, auth and storage contracts are frozen.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering
   codename and must never appear in a user-visible string, id or installer name.
