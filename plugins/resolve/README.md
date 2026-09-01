# DaVinci Resolve script

`aksharo_core`: an in-app Python script launched from Workspace ▸ Scripts that captions a Resolve timeline with Fusion Text+ nodes.

**Status:** placeholder — no code yet. Scaffolded by A01 so the workspace layout
matches `03-architecture/10-build-plan.md` section 1.
**Implemented by:** C08 (core script), C08b (Text+ macro), C09 (Studio panel), C10 (installer). See `docs/PLAN.md` for scheduling and blockers.

## Intended stack

| Piece          | Choice                                                             | Why                                                                                |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Entry point    | in-app Python from **Workspace ▸ Scripts**                         | the only path that reaches **Free** users; external scripting is Studio-only (D22) |
| Module         | `aksharo_core` (from `PLUGIN_IDS` in `@montaj/config`)             |                                                                                    |
| Transport      | a loopback server started inside Resolve, talking to `apps/bridge` |                                                                                    |
| Captions       | a Fusion **Text+** macro with per-word highlight                   |                                                                                    |
| Timeline state | host ids in marker `customData`                                    | survives user edits                                                                |
| Studio extra   | a docked Workflow Integration panel over the same core (C09)       |                                                                                    |

## Notes

**Blocked on a human spike:** A00-04 in `docs/PLAN.md` must confirm on Resolve Free
19.1 or later that a Utility script receives the `resolve` object, that a loopback
server can run inside Resolve, and that Text+ macro insert works.

## Before writing code here

1. Check `docs/PLAN.md` — this work package may be blocked on a Wave 0 human item.
2. Read `docs/CONTRACTS.md`; the queue, auth and storage contracts are frozen.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering
   codename and must never appear in a user-visible string, id or installer name.
