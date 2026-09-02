# @montaj/bridge

The local bridge: a Node single-executable that lets Premiere, After Effects and DaVinci Resolve talk to the platform from the user's machine.

**Status:** C01 implemented the SEA wrapper (`src/main.ts`), local config
(`src/config.ts`), and the `scripts/build-sea.mjs` build (esbuild bundle →
`--experimental-sea-config` → `postject`); all protocol/server/pairing logic
lives in `@montaj/bridge-core`, which this app only wires up. Smoke tested
locally on Windows: the built binary starts standalone (no `node_modules`
beside it), binds a loopback port, generates a per-install cert, and writes a
valid discovery file. CI runs the same smoke check on Windows and macOS
(`bridge-sea` job in `.github/workflows/ci.yml`, via
`scripts/ci/bridge-sea-smoke.mjs`).
**C01b (this WP) added:** a native system tray (`src/native-tray.ts`) for this
standalone install path, OS keychain/DPAPI storage for the private key
(`@montaj/bridge-core`'s `keystore.ts`), and a `workflow_dispatch` trigger plus
a fixed hang risk on the `bridge-sea` CI job — see "Native tray" and "CI" below.

**Still not implemented** (unchanged from C01's report): signing of the SEA
binary (C00's job); an autostart toggle UI (the config flag `autostart` exists
in `src/config.ts` but nothing reads it yet — a future WP wires it to the OS
service manager).
**Implemented by:** C01 (bridge v2), C01b (native tray, keychain/DPAPI, CI fix), C02 (embedded in the desktop app). See `docs/PLAN.md` for scheduling and blockers.

## Native tray

`src/native-tray.ts` wraps [`systray2`](https://www.npmjs.com/package/systray2)
(MIT) behind `bridge-core`'s `TrayController` interface. `systray2` spawns a
small prebuilt per-OS helper binary over stdio rather than compiling a native
Node addon — the only approach that survives `scripts/build-sea.mjs` bundling
everything into one `dist/bundle.cjs` (a `.node` addon has no stable path once
that happens). `build-sea.mjs` copies `systray2`'s `traybin/` directory to
`dist/traybin` next to the packaged executable at build time (never committed
to the repo).

**License/maintenance note:** `systray2`'s last npm release predates this WP by
several years. It was still the best fit found after surveying the ecosystem
(see the WP report) — every actively-maintained alternative is a native addon
requiring a compiler, which the SEA constraint above rules out. This is a
documented risk, not a hidden one: revisit if a better-maintained,
addon-free option appears.

**Fallback to the console tray** (`bridge-core`'s `createConsoleTray`) happens
whenever a native tray cannot be shown, all handled by `createNativeTray`
resolving `undefined` rather than throwing:

- Linux with no `DISPLAY` set.
- Any `CI` environment (`process.env.CI` set) — a CI runner reports a session
  but has no real interactive desktop backing the notification area; spawning
  the helper there was observed to hang rather than fail fast, which would
  wedge the `bridge-sea` smoke test indefinitely. `createNativeTray` also
  wraps `ready()` in a 3s timeout for the same reason outside CI.
- The packaged build is missing `dist/traybin` (helper binary not shipped
  alongside the executable).
- `systray2` itself fails to import, or the helper process fails/times out.

Pairing still works via the 8-character code in every fallback case.

## CI

The `bridge-sea` matrix job (`.github/workflows/ci.yml`) already ran on every
push to a `wp/**` branch; `on:` now also has `workflow_dispatch: {}` so it (and
every other job in `ci.yml`) can be re-run manually from the Actions UI or
`gh workflow run ci.yml` without an empty commit. To dry-run the job's actual
steps locally (this repo has no Docker available for a real `act` run, and the
job is platform-specific anyway):

```sh
pnpm --filter @montaj/bridge... build
pnpm --filter @montaj/bridge build:sea
node scripts/ci/bridge-sea-smoke.mjs
```

This is exactly what surfaced the CI-env tray hang above — the smoke test
hung intermittently without the `CI`-env skip in `native-tray.ts`, which would
have made the matrix job flaky (not merely slow) on Windows/macOS runners.

## Intended stack

| Piece              | Choice                                                                    | Why                                                 |
| ------------------ | ------------------------------------------------------------------------- | --------------------------------------------------- |
| Packaging          | Node SEA (single executable)                                              | no runtime install for plugin-only users            |
| Primary transport  | **outbound WSS relay** to the gateway, room `bridge:{workspaceId}`        | no inbound ports, survives corporate networks (D25) |
| Fallback transport | loopback HTTPS on ports 47831–47833, per-install certificate              | UXP manifests need a fixed port ladder              |
| Pairing            | tray gesture, with an 8-character base32 single-use 60 s code as fallback |                                                     |
| Tokens             | 12-hour scoped pair tokens, held in memory by panels                      | CEP is Chromium 99 (T13)                            |

## Notes

This is the most security-sensitive surface in the product: anything that reaches
the bridge can spend credits, mutate projects and run local jobs. THREAT-MODEL
T11–T14 are binding:

- bearer token on **every** route including `/status`;
- `Host` must be `127.0.0.1` or `localhost` on the expected port;
- `Origin` allow-list plus a preflight-forcing custom header;
- no cookies, ever (they would make DNS rebinding exploitable);
- discovery file written `0600` and containing the token;
- the loopback private key lives in the OS keychain or DPAPI and is regenerated on reinstall.

## Before writing code here

1. Check `docs/PLAN.md` — this work package may be blocked on a Wave 0 human item.
2. Read `docs/CONTRACTS.md`; the queue, auth and storage contracts are frozen.
3. Take brand strings from `@montaj/config` — `montaj` is the engineering
   codename and must never appear in a user-visible string, id or installer name.
