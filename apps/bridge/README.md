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

## Native tray — off by default (coordinator ruling, 2026-09-03)

`src/native-tray.ts` wraps [`systray2`](https://www.npmjs.com/package/systray2)
(MIT) behind `bridge-core`'s `TrayController` interface. `systray2` spawns a
small prebuilt per-OS helper binary over stdio rather than compiling a native
Node addon — the only approach that survives `scripts/build-sea.mjs` bundling
everything into one `dist/bundle.cjs` (a `.node` addon has no stable path once
that happens).

**This is disabled by default, on both ends, and must be opted into explicitly:**

- **Runtime:** `createNativeTray()` returns `undefined` (console fallback)
  unless the environment variable `AKSHARO_BRIDGE_TRAY=native` is set for the
  running process.
- **Build:** `build-sea.mjs` only copies `systray2`'s `traybin/` helper
  binaries into `dist/traybin` (never committed to the repo) when
  `AKSHARO_BRIDGE_TRAY=native` is set in the build environment; a default
  build ships no tray helper binary at all.

**Why:** `systray2`'s last npm release predates this WP by several years —
maintained enough to be the best fit surveyed (every actively-maintained
alternative is a native addon requiring a compiler, which the SEA constraint
above rules out), but an unreleased-for-years dependency that ships prebuilt
native helper binaries is a supply-chain exposure the coordinator ruled
unacceptable to carry by default into a code-signed product. Pairing already
works headlessly via the 8-character code shown in the console fallback, so
there is no functional loss in shipping with the flag off; the desktop
shell's Electron tray (C02, driven through `apps/desktop/src/bridge/
adapter.ts`) remains the product's actual tray surface.

**Replacement criteria** — swap in a different tray library (drop the flag,
default it on) only once one exists that is simultaneously:

1. **Maintained** — released within roughly the last year, not archived.
2. **Permissively licensed** — MIT/Apache/BSD/ISC (H-14).
3. **SEA-compatible** — no native Node addon (a `.node` file has no stable
   path once esbuild folds everything into one `dist/bundle.cjs`); a
   spawned-helper-binary or pure-JS design is fine.

**Fallback to the console tray** (`bridge-core`'s `createConsoleTray`) happens
whenever the native tray is not enabled or cannot be shown, all handled by
`createNativeTray` resolving `undefined` rather than throwing:

- `AKSHARO_BRIDGE_TRAY` is not `"native"` (the default — see above).
- Linux with no `DISPLAY` set.
- Any `CI` environment (`process.env.CI` set) — a CI runner reports a session
  but has no real interactive desktop backing the notification area; spawning
  the helper there was observed to hang rather than fail fast, which would
  wedge the `bridge-sea` smoke test indefinitely. `createNativeTray` also
  wraps `ready()` in a 3s timeout for the same reason outside CI. (Both guards
  stay in place as defense-in-depth even though the opt-in flag already keeps
  CI from reaching this code path.)
- The packaged build is missing `dist/traybin` (helper binary not copied in
  because the build did not set `AKSHARO_BRIDGE_TRAY=native`).
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

## Telemetry consent sync (M04, C12 follow-up)

`config.telemetryConsent` used to default to `false` with no way to learn the
server actually granted it. `main.ts` now:

1. Reads `GET /consents` with the bridge's own device token on every startup
   (`consent-sync.ts`'s `fetchTelemetryConsent`) and persists whatever it
   learns before deciding whether to construct the telemetry client.
2. Polls the same endpoint every 5 minutes (`startConsentPolling`) and, on a
   change, starts or stops the telemetry client live — no restart needed.

`GET /consents` opted into `@AllowBridgeToken()` on the API side for this
(`apps/api/src/consents/consents.controller.ts`). There is no push channel
from the API to an unpaired bridge process today (`/bridge/relay` only pairs
one bridge with one connected client), so this is a poll, not a subscription
— see `consent-sync.ts`'s doc comment for the full reasoning.

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
