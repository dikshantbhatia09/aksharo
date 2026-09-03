# @montaj/bridge-core

The local bridge's protocol, servers, pairing and relay client — everything
`apps/bridge` (the Node SEA wrapper) and the desktop shell (C02) need, behind
one small public API.

## Public API

```ts
import { BridgeCore } from "@montaj/bridge-core";

const bridge = new BridgeCore({
  relayUrl: "wss://api.aksharo.ai/bridge/relay", // omit to run loopback-only
  deviceToken: "...",
  tray: myTrayController, // optional; defaults to a console-logging headless tray
});

bridge.on("status", (event) => console.log(event.status, event.port));
bridge.on("pairingRequested", (pairingId, clientName) => {
  /* show a tray notification, or log the 8-character code for the fallback */
});
bridge.on("clientConnected", ({ pairingId, clientId, clientKind }) => {
  // C02b: fires once `pair.confirm` mints the real wire `clientId` — a local/tray
  // approval only flips the pairing to "approved"; the pairing *client* itself
  // mints and owns `clientId`, so this is the only way an in-process consumer
  // (the desktop shell) learns it. No wire `events.subscribe` broadcast exists
  // yet for a remote subscriber; see `BridgeEventKind` in `protocol.ts`.
});

await bridge.start(); // binds loopback (47831-47833), writes the discovery
// file, opens the relay tunnel if configured
await bridge.stop();
```

That is the whole surface a consumer needs. Everything else in this package
(`protocol.ts`, `server.ts`, `pairing.ts`, `cert.ts`, `discovery.ts`,
`relay-client.ts`, `security.ts`, `tray.ts`) is implementation `BridgeCore`
wires together and is exported for `apps/bridge` and tests, not for a second
independent consumer to reassemble.

## Protocol

JSON-RPC 2.0 over both transports (loopback WebSocket/HTTPS and the relay
tunnel), one zod schema set for both (`protocol.ts`). Methods: `hello`,
`pair.request`/`pair.confirm`, `session.exchange`, `host.list`,
`engine.status`, `fs.pickMedia`, `media.stat`/`media.uploadTicket`,
`transcript.push`, `apply.begin/step/commit/abort`, `events.subscribe`.
`hello`/`pair.request`/`pair.confirm` are the only methods callable before
`session.exchange`.

## Security controls (THREAT-MODEL T10-T14)

Every route on the loopback server runs, in order: bearer (constant-time
compare) → `Host` (must be `127.0.0.1:<port>` or `localhost:<port>`) → `Origin`
(allowlist; `null` never allowed; Chrome Local Network Access header sent only
for an allowlisted origin) → message size (512 KB) → rate limit.

## Certificate

A per-install leaf certificate is generated on first run and cached under
`~/.aksharo/cert/` (never committed, never shared between installs). It is
**RSA 2048**, not the brief's requested ECDSA P-256 — see the deviation note in
`cert.ts`: the `selfsigned` package (built on node-forge) only ever signs with
an RSA key it generates itself, and node-forge has no supported path for
issuing an EC-signed certificate. The leaf is pinned by SHA-256 fingerprint
(published in the discovery file) rather than trusted via a CA chain, so this
does not weaken the loopback-TLS control.

The certificate (public) still lives on disk; the **private key** does not —
see "Key storage" below (THREAT-MODEL T14).

## Key storage (`keystore.ts`, C01b)

`KeyStore` is the interface `cert.ts` uses to persist the loopback private key.
`createDefaultKeyStore()` picks, per OS, the backend that keeps that key out of
a plain file:

| Platform | Backend            | Mechanism                                                                                                                                     |
| -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS    | `KeychainKeyStore` | shells out to the `security` CLI (generic password item) — Apple's own tool, not an npm package                                               |
| Windows  | `DpapiKeyStore`    | shells out to `powershell.exe` calling `System.Security.Cryptography.ProtectedData` (DPAPI, `CurrentUser` scope), ciphertext cached in a file |
| other    | `FileKeyStore`     | the original `0600` file, unchanged — the documented fallback                                                                                 |

No new native/npm dependency was added for this: a keychain client library is
a native addon on every OS we ship, and a native addon has no stable path once
`apps/bridge`'s esbuild bundle folds everything into one `dist/bundle.cjs` — so
shelling out to a tool the OS itself already ships and maintains is the only
approach that works inside the Node SEA binary. `createDefaultKeyStore()`
probes its candidate once (a real save/load/delete round-trip) before trusting
it, and falls back to `FileKeyStore` if the probe fails (headless CI runner, a
locked-down PowerShell execution policy, etc.) — so the choice reflects what
actually works on this machine, not just `os.platform()`.

**Migration:** an install from before C01b has the private key sitting in
`~/.aksharo/cert/leaf.key.pem` (mode `0600`). The first `loadOrCreateCertificate()`
call after upgrading reads that file, saves it into the key store, and deletes
the plaintext copy — the existing cert/fingerprint (and therefore existing
pairings) survive the upgrade.

Tests use `InMemoryKeyStore` exclusively — no test spawns `security` or
PowerShell, real machine state is never touched. (Windows CI/dev runs of this
package's own `vitest` suite do exercise `createDefaultKeyStore()`'s probe for
real, since `platform() === "win32"` is true there.)

## Discovery file

`~/.aksharo/bridge.json`, mode `0600`: `{port, certFingerprint, bearer, pid,
version, startedAt}`. Written atomically (temp file + rename) on every start.

## Pairing

A tray gesture ("Approve pairing for \<client\>?") or, headless, an
8-character code (no ambiguous glyphs). Approval issues a 12-hour HMAC-signed
scoped pair token; `session.exchange` trades it for a short-lived session
token. Revocable by `clientId`.

## Tray

`TrayController` is an interface; `createConsoleTray()` is the only
implementation shipped by this work package — it logs the pairing code instead
of showing a tray icon, so pairing still works headless (CI, this package's own
tests) and from a terminal. A real system tray is `apps/bridge`'s job; see its
README for the current status.
