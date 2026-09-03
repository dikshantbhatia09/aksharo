# @montaj/shared-apply

Host-neutral apply-plan builder (D09): turns `accepted` EDG pass items (`cut`/`zoom`/`sfx`/
`music`/`title`) into host-neutral operations (`ApplyOp`) both `plugins/premiere-uxp` and
`plugins/resolve` apply, so neither plugin re-derives which items produce a mutation, what the
D43 licence gate says, or how a `motionPreset` maps to a param table independently.

## Why this package exists

D09's brief asked for either "a Python port for Resolve, or JSON exchange through the bridge —
pick one and justify." Porting the whole plan-_building_ logic (the licence gate, the six D06
motion presets' param mapping, which item kinds/states ever produce an op) to Python as well
would mean two independently-maintained copies of that logic — the actual drift risk. Instead:

- This package is pure TS + `zod`, no Node-only dependencies, so `plugins/premiere-uxp` imports
  it directly (a plain `dependencies` entry, same as `@montaj/caption-styles`) and bundles it
  with esbuild like everything else in that plugin.
- `plugins/resolve` cannot `require()` TypeScript, so it ports only the small, stable **shapes**
  (`aksharo_core_app/apply_plan.py`'s dataclasses) and the small, stable **static tables**
  (`licence.py`, `motion_presets.py`) — never the branching logic that decides what a plan
  contains.
- A checked-in fixture pair, `fixtures/sample-items.json` -> `fixtures/sample-plan.json`, is the
  parity source both `src/planBuilder.test.ts` (TS) and
  `plugins/resolve/tests/test_apply_plan_parity.py` (Python) load and assert against — proving
  one EDG state produces a structurally equivalent plan on both runtimes without a duplicated
  builder.

## Layout

| Path                         | What                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`               | `ApplyPlanItem`/`ApplyOp`/`ApplyPlan` shapes, mirroring CONTRACTS §2 (re-declared, not imported, matching `plugins/premiere-uxp/src/apply/types.ts`'s own rule) |
| `src/licence.ts`             | D43 client-side re-check: `allowsRawFileDelivery` + `licenceSnapshot.surface` includes `"panel"`                                                                |
| `src/motionPresets.ts`       | `TitlePayload.motionPreset` → MOGRT/Text+ param table mapping (six D06 presets, four layout candidates, four intent defaults)                                   |
| `src/planBuilder.ts`         | `buildApplyPlan`: the one function that decides which accepted items become which `ApplyOp`s                                                                    |
| `fixtures/sample-items.json` | The TS/Python parity fixture's input (one EDG state)                                                                                                            |
| `fixtures/sample-plan.json`  | The golden `ApplyPlan` both languages' tests assert against                                                                                                     |

## Consumers

- `plugins/premiere-uxp/src/apply/sfxMusic.ts` / `src/apply/titles.ts` call `buildApplyPlan`
  directly and turn its `AudioClipOp`/`TitleParamOp`s into `PremiereHost` calls.
- `plugins/resolve/aksharo_core_app/apply_plan.py` parses the same JSON shape (not built here);
  `aksharo_core_app/sfx_music.py` / `titles.py` re-implement the licence/preset _tables_ (not the
  plan-building loop) against their own item dataclasses, since Resolve's plugin has no producer
  today that hands it a pre-built JS plan over the bridge.

## Coverage

CONTRACTS §9: this package is pure logic (no host, no I/O), held to the 90/85 bar (like
`packages/edg`/`packages/timemap`), not the lighter 60/50 plugin-adapter bar.
