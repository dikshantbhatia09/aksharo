# DaVinci Resolve script — Aksharo — works with DaVinci Resolve

> Aksharo is an independent product that works with DaVinci Resolve. It is not
> made, endorsed, or supported by Blackmagic Design.

`aksharo_core.py`: an in-app Python script launched from **Workspace ▸
Scripts** that captions a Resolve timeline with Fusion Text+ nodes, applies
accepted autocut/zoom pass items, and keeps host state in marker `customData`
so re-sync can find what it created.

**Implemented by:** C08 (this work package — core script, loopback server,
bridge client, captions, cuts/zooms, marker mapping). **Not in this WP:**
C08b (Fusion Text+ macro authoring), C09 (Studio docked panel), C10
(installer that copies this tree into Resolve's `Scripts/Utility`).

## Layout

| Path                               | What                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `aksharo_core.py`                  | Thin bootstrap Resolve `exec`s from Workspace ▸ Scripts. Cannot itself be a package (Python won't let a same-named file and package directory coexist), so it only does `sys.path` setup and delegates to `aksharo_core_app`.                                                                                                              |
| `aksharo_core_app/`                | The real, unit-tested library. Everything here runs headless in CI against `FakeResolveHost`.                                                                                                                                                                                                                                              |
| `aksharo_core_app/host/resolve.py` | The **only** module that imports the real `DaVinciResolveScript`, lazily, at call time. `ResolveHost` is the typed seam; `FakeResolveHost` mirrors the documented object model (ProjectManager → Project → MediaPool → Timeline → TimelineItem, plus a Fusion comp for Text+) so every other module is testable without Resolve installed. |
| `aksharo_core_app/keyframes.py`    | Python port of `packages/edg/src/passes/keyframes.ts`'s MKF2 packed keyframe format (round-trip tested against the same fixture bytes as the TS module).                                                                                                                                                                                   |
| `aksharo_core_app/captions.py`     | Builds one Text+ clip per EDG transcript segment; unsupported styles (A18a `assRenderable=false`) fall back to importing a rendered alpha overlay.                                                                                                                                                                                         |
| `aksharo_core_app/cuts.py`         | Accepted `cut` pass items → `Timeline.DeleteClips(items, ripple=True)`.                                                                                                                                                                                                                                                                    |
| `aksharo_core_app/zooms.py`        | Accepted `zoom` pass items → Dynamic Zoom start/end rects, decoded from MKF2 keyframes (approximated to the first/last keyframe — see "Known limitations").                                                                                                                                                                                |
| `aksharo_core_app/markers.py`      | The `{aksharo: {projectId, segmentId\|itemId, rev}}` marker `customData` convention and re-sync lookups.                                                                                                                                                                                                                                   |
| `aksharo_core_app/bridge/`         | JSON-RPC 2.0 client for the C01 local bridge protocol, plus the B08b device-code bootstrap for this script's own credential.                                                                                                                                                                                                               |
| `aksharo_core_app/server.py`       | The in-Resolve loopback server (`host.info`, `timeline.current`, `apply.*`).                                                                                                                                                                                                                                                               |

## Running the tests

```
pnpm --filter @montaj/resolve test   # pytest, via the plugin's own .venv
pnpm --filter @montaj/resolve lint   # ruff check
pnpm --filter @montaj/resolve typecheck   # mypy --strict
```

The venv is created on first use at `plugins/resolve/.venv` (see
`scripts/py.mjs`, mirroring `apps/worker-ai`'s wrapper).

## Known limitations / open questions for A00-04

DaVinci Resolve is not installed on any machine that has built this package,
and the human spike **A00-04** (Resolve scripting API coverage on Free vs
Studio, `docs/PLAN.md`) has not reported. Until it does:

- **Whether a Utility script receives the `resolve` global on Free the same
  way Studio does** is unconfirmed. `aksharo_core.py` checks for it and prints
  a clear message instead of guessing.
- **Whether a loopback HTTP/WS server can run inside the Resolve process** at
  all (thread/event-loop restrictions) is unconfirmed.
- **`DynamicZoomEase` is not a literal scripting API method name.** The
  architecture doc names Resolve's Dynamic Zoom inspector feature that way;
  the scripting surface only exposes `TimelineItem.SetProperty()` on
  documented common keys (`Zoom_Start`/`Zoom_End`/`Pan_*`/`Tilt_*`/`Ease` used
  here are this work package's best-effort guess at the property names Resolve
  keyframes when Dynamic Zoom is enabled on a clip — **needs verification
  against a real Resolve install**). A B19 zoom curve's intermediate keyframes
  are always collapsed to their first/last point, because Resolve's Dynamic
  Zoom is a two-point ease, not an arbitrary curve.
- **No scripted "apply transaction" / undo-group API is documented.** Each
  clip this script deletes or creates is an individually undoable Resolve
  action, not one grouped undo; `cuts.py`'s `ApplyCutsResult.warning` states
  this so callers can surface it to the user.
- **The Text+ param table is minimal** (text, font, size, colour, position)
  until C08b's macro lands and documents its own parameter names.

## Non-affiliation

Aksharo is an independent product that works with DaVinci Resolve. It is not
made, endorsed, or supported by Blackmagic Design. This line (and the console
banner in `aksharo_core_app/console.py`) must ship with every build.
