# @montaj/bridge

The local bridge: a Node single-executable that lets Premiere, After Effects and DaVinci Resolve talk to the platform from the user's machine.

**Status:** placeholder — no code yet. Scaffolded by A01 so the workspace layout
matches `03-architecture/10-build-plan.md` section 1.
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
