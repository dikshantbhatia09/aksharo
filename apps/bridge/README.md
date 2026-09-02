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
**Not implemented by C01** (see the WP report's open questions): a real
system tray (this app currently uses `bridge-core`'s console-logging headless
tray fallback — pairing still works via the 8-character code, but there is no
tray icon, no native "Approve pairing?" gesture, and no autostart toggle UI);
signing of the SEA binary (C00's job); the OS-keychain/DPAPI storage this
README's own "Notes" section below calls for (the current cert/key live on
disk under `~/.aksharo/cert/`, mode `0600`, not in a keychain).
**Implemented by:** C01 (bridge v2), C02 (embedded in the desktop app). See `docs/PLAN.md` for scheduling and blockers.

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
