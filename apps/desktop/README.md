# @montaj/desktop

Electron shell that loads the **hosted** Aksharo web app (decision D71 —
supersedes the "packaged web bundle" wording in `10-build-plan.md`: one web
codebase, instant updates; a packaged offline UI arrives only with local mode,
C04), with the local bridge embedded in-process, `electron-updater` channels,
native menus/tray and `aksharo://` deep links.

**Status:** implemented by **C02**; bridge adapter wiring, pairing approval
UX, device bootstrap, Electron e2e CI and packaging integration by **C02b**.
Local engine (C03a/b), local mode (C04) and installers/marketplace (C10) are
out of scope here.

## Security configuration

| Setting                   | Value                                                                                                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contextIsolation`        | `true`                                                                                                                                                                                                                                                                              |
| `sandbox`                 | `true`                                                                                                                                                                                                                                                                              |
| `nodeIntegration`         | `false`                                                                                                                                                                                                                                                                             |
| `webSecurity`             | `true`                                                                                                                                                                                                                                                                              |
| Single instance           | `app.requestSingleInstanceLock()`; second instance forwards its argv (deep link) and focuses the existing window                                                                                                                                                                    |
| Navigation allowlist      | `src/security/allowlist.ts` — top-level navigation limited to the hosted app origin(s) + Google OAuth; `window.open` routed to a controlled child window (OAuth, Razorpay checkout) or the OS browser, or denied; `shell.openExternal` limited to the brand domain + OAuth/Razorpay |
| Offline page CSP          | `src/security/csp.ts` — `default-src 'none'`, no inline script, no eval                                                                                                                                                                                                             |
| Electron fuses (packaged) | `RunAsNode` off, cookie encryption on, ASAR integrity validation on, Node CLI/env-var inspection off — flipped in `scripts/after-pack.cjs` (electron-builder `afterPack`)                                                                                                           |
| Bundle id                 | `ai.aksharo.desktop` (CONTRACTS §0)                                                                                                                                                                                                                                                 |

## Preload API surface (`window.aksharoDesktop`, `src/preload/api-types.ts`)

```ts
interface AksharoDesktopApi {
  version: string;
  platform: NodeJS.Platform;
  openMediaDialog(): Promise<string[]>;
  engine: { status(): Promise<{ state: "unavailable" }> }; // real status arrives with C03
  bridge: {
    pair(pairingId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    deny(pairingId: string): Promise<{ ok: true } | { ok: false; error: string }>;
    provideAccessToken(token: string): Promise<{ ok: true }>;
    onPairingRequested(listener: (pairing: DesktopPendingPairing) => void): () => void;
    onClientConnected(listener: (client: DesktopClientConnected) => void): () => void;
  };
  updates: { check(): Promise<{ channel; available; version? }> };
  deepLink: { onOpen(listener: (url: string) => void): () => void };
}
```

`apps/web/lib/desktop.ts` is the one file this WP touches under `apps/web`
(agreed with A13): it detects the shell via the `?desktop=1` query flag and/or
the `AksharoDesktop/<version>` User-Agent suffix, and exposes a typed accessor
for the same API from the web app's side.

## Deep-link routes (`src/deeplink/parse.ts`)

- `aksharo://auth/callback?code=<token>[&state=<token>]` — device-code/browser sign-in hand-off
- `aksharo://project/<ulid>` — open a project
- `aksharo://pair?code=<pair code>` — bridge pairing hand-off (C01)

Unknown hosts, malformed ids/tokens or a foreign scheme all parse to `null`
and are ignored — never a best-effort navigation. Registered via
`app.setAsDefaultProtocolClient` (Windows registry / macOS `CFBundleURLTypes`
via `electron-builder.yml` `protocols:` / Linux desktop file, all wired by
electron-builder); dispatch on macOS via `app.on("open-url")`, on
Windows/Linux via the single-instance-lock `second-instance` argv.

## Updater (`src/updater/feed.ts`, wired in `src/main/index.ts`)

`electron-updater`, `provider: "generic"`, feed `https://releases.<BRAND.domain>/releases/<channel>/`
(C00's layout), channels `alpha`/`beta`/`stable` (`setUpdateChannel`),
differential updates via electron-updater's blockmap support (automatic,
no extra config needed on the client side), deterministic staged-rollout gate
(`isEligibleForRollout`, hashes a per-install id against the feed's
`stagedRolloutPercentage`), `update-available`/`update-downloaded` events
forwarded to the renderer for the restart-prompt UI. Signature verification
relies on OS code signing done by C00 (not yet landed — see Open questions).

## Embedded bridge (C02b)

`src/bridge/adapter.ts` defines `BridgeAdapter`
(start/stop/approvePairing/denyPairing/status/onPairingRequested/
onClientConnected) and ships two implementations: `createStubBridgeAdapter()`
(bridge disabled — used until a device credential exists) and
`createBridgeAdapter()` (the real one, wrapping `@montaj/bridge-core`'s
`BridgeCore`). `approvePairing(pairingId)` returns `{pairingId, approved:
true}` only — the real wire `clientId` is never known synchronously (the
pairing _client_ mints it via its own `pair.confirm` call); the desktop
learns it later via `onClientConnected`, once `BridgeCore` emits its
`clientConnected` event.

**Pairing approval UX:** `onPairingRequested` fires the moment a pairing
request arrives (tray gesture). `main/index.ts` shows a small approval window
(`src/main/pairing-window.ts` + `pairing-approval.html`/`.ts` +
`pairing-preload.ts`) with the 8-char code, client name/kind, Approve/Deny
buttons and a 60s auto-deny timer; the window has its own minimal
`contextIsolation`/`sandbox` preload (`window.pairingApproval.decide`), never
reachable from the hosted app's renderer (THREAT-MODEL T25 — no new
privileges on the main window). The tray's "Approve pairing…" item
(`src/tray/index.ts`) just re-focuses this window if one is pending
(`hasPendingPairing()`).

**Device bootstrap** (`src/bridge/device-bootstrap.ts`): on first run,
registers this install (`POST /devices/register`, B08) and mints a
`kind:"bridge"` token (`POST /devices/{id}/bridge-token`, B08b) given a user
access token, caching both (plus a generated per-install fingerprint) in
`bridge-core`'s OS keystore so a restart doesn't re-register while the lease
is fresh. Requires the hosted web app (already signed in, running in
`mainWindow`) to hand its access token down via
`window.aksharoDesktop.bridge.provideAccessToken(token)` — the web-side call
site is out of this WP's `apps/desktop/**` boundary (open question). Once a
credential is minted, `main/index.ts`'s `attachRealBridge` swaps the stub
adapter for `createBridgeAdapter({relayUrl, deviceToken})` and starts it,
no restart needed.

## Tests

- `vitest run` — allowlist, deep-link parsing, updater feed/rollout math, the
  bridge adapter (stub + real, including `approvePairing`/`denyPairing`/
  `onPairingRequested`/`onClientConnected`), device bootstrap. Pure-logic
  modules only; main/preload/pairing-window wiring needs a real Electron
  runtime.
- `pnpm test:e2e` (Playwright-Electron, `e2e/smoke.spec.ts`) — launch, offline
  page renders (forced via `AKSHARO_DESKTOP_TEST_APP_URL`, a test-only escape
  hatch gated on `app.isPackaged === false`), preload API present with no
  `ipcRenderer`/`process` leak into the page. Requires `pnpm build` first and
  a display (Xvfb on headless Linux CI). **C02b:** runs in CI via
  `.github/workflows/release-desktop.yml`'s `e2e` job on a real mac/win
  runner matrix (`electron-builder --dir` then this suite); locally it stays
  a manual step — it fails in this repo's sandboxed dev environment
  (`Error: Process failed to launch!`, consistent with a Chromium
  network-service crash under container restrictions), so don't expect it
  green there.
- `pnpm pack:dry` — unsigned `electron-builder --dir` build (fuses hook
  included) for a packaging smoke check; real signing/notarisation/channels
  hosting is C00. **Known blocker (C02b, not yet fixed):** in this pnpm
  workspace this currently fails before producing output — `node_modules/
@montaj/{bridge-core,config}` are pnpm symlinks whose real path resolves
  outside `apps/desktop/`, and electron-builder's asar packager refuses a
  file it can't express as a path relative to the app dir. See
  `tools/release/src/commands/buildDesktop.ts`'s `findRealElectronBuilderOutput`
  doc comment for the full write-up and candidate fixes (`pnpm deploy`, an
  app-local hoisted linker, or bundling the main process) — flagged for C00.
