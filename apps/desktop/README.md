# @montaj/desktop

Electron shell that loads the **hosted** Aksharo web app (decision D71 —
supersedes the "packaged web bundle" wording in `10-build-plan.md`: one web
codebase, instant updates; a packaged offline UI arrives only with local mode,
C04), with the local bridge embedded in-process, `electron-updater` channels,
native menus/tray and `aksharo://` deep links.

**Status:** implemented by **C02**; bridge adapter wiring, pairing approval
UX, device bootstrap, Electron e2e CI and packaging integration by **C02b**.
Local mode (`src/local/**`) by **C04**. Local engine real backends (C03b) and
installers/marketplace (C10) are out of scope here.

## Local mode (`src/local/**`, C04)

SQLite + files, local export, no uploads (`03-architecture/05-system-
architecture.md` §7). Starter and above (`packages/config`'s
`hasLocalMode`/`LOCAL_MODE_MIN_PLAN`); the desktop fails closed until the
hosted web app has reported a plan (`desktop:local-set-plan`).

**Driver: `sql.js` (MIT), not `better-sqlite3`.** `better-sqlite3` is a
native addon needing a prebuilt binary for Electron's exact Node ABI (or a
full toolchain to compile one) and, per this WP's own brief, would have to
be added to `scripts/bundle.mjs`'s esbuild `external` list with its
compiled `.node` file copied into `dist/` by hand for every platform/arch
electron-builder ships. In this sandbox `better-sqlite3@11` failed to
install outright (`prebuild-install`: no prebuilt binary for this Node ABI;
`node-gyp rebuild`: no Visual Studio toolchain) — a real symptom of the
same brittleness, not just a local inconvenience. `sql.js` compiles SQLite
to WebAssembly once, upstream, and ships the `.wasm` as a plain package
asset with no native compilation on any platform: `scripts/copy-static.mjs`
copies it from `node_modules/sql.js/dist/sql-wasm.wasm` to
`dist/main/sql-wasm.wasm` at build time (never committed), and esbuild
inlines the (pure-JS) loader like every other pure-JS dependency — no
change to the `external` list. The tradeoff: `sql.js` has no built-in file
journal, so `src/local/db.ts` serialises the whole database back to disk
after every mutation (`persist()`); acceptable because this store's rows
are metadata only — media stays on disk as files, never a BLOB, so the
database itself stays kilobytes, not media-sized.

**Schema** (`src/local/schema.ts`): `local_projects`, `local_media`,
`local_edg_snapshots` (EDG v2 `{hot, segments}` JSON per revision),
`local_exports`. Deletes cascade in `LocalStore#deleteProject` rather than
via `ON DELETE`, so the media files on disk are removed in the same call
that removes the rows.

**IPC surface** (`window.aksharoDesktop.local`, `src/preload/api-types.ts`):
`isEnabled`, `createProject`/`listProjects`/`openProject`/`deleteProject`,
`importMedia`/`listMedia`, `transcribe`/`align` (delegate to the engine
sidecar, C03a's `@montaj/engine-client`, found via its discovery file —
`src/local/engine-connection.ts`, independent of `apps/engine/src/
discovery.ts` since apps do not import each other's `src/`),
`saveEdgSnapshot`/`latestSnapshot`, `runExport`/`listExports` (delegates to
the engine's `/render`). Every handler throws `local/disabled` until
`desktop:local-set-plan` has reported Starter+.

**Network guard** (`src/local/network-guard.ts`, THREAT-MODEL T25): blocks
`POST`/`PUT`/`PATCH` requests to the hosted API's origins while a local
project is open, wired into `session.defaultSession.webRequest.
onBeforeRequest` in the main process — not a preload `fetch` patch, since
`contextIsolation` puts the preload's JS in a different world than the
hosted page's and would never see the page's own network calls. GETs and
requests to the local engine/OAuth/CDN are never blocked; only the upload
path local mode promises not to take.

**Media probe.** `apps/engine`'s contract (`README.md`) has no dedicated
probe route yet — only `/transcribe`, `/align`, `/clean`, `/render`,
`/models`, `/health` — so `importMedia`'s duration/fps/width/height are
`null` until a caller supplies them. Open question for C03b (whose real
ffmpeg backend is the natural place for a probe route).

**Tests:** `src/local/*.test.ts` — schema/persistence (`db.test.ts`), the
full round trip create → import → transcribe (mocked `EngineClient`) → save
EDG → export (`store.test.ts`), the network guard and entitlement gate as
pure predicates, and the engine discovery reader. All in-memory/injected —
no Electron runtime, no real engine sidecar, no native module.

**Electron smoke path for Gate C** (no Playwright budget for this WP, per
the host guard): `pnpm build && pnpm pack:dry`, launch the unpacked build,
and manually: create a local project, import a media file via the native
picker, confirm "Local projects" lists it on Home, open DevTools' Network
tab and confirm no request reaches `api.<domain>` while the project stays
open, then delete the project and confirm its media directory is gone from
`app.getPath("userData")/local-media`.

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
  hosting is C00. **Fixed by C00b** (was: "in this pnpm workspace this
  currently fails before producing output — `node_modules/@montaj/{bridge-core,
config}` are pnpm symlinks whose real path resolves outside `apps/desktop/`,
  and electron-builder's asar packager refuses a file it can't express as a
  path relative to the app dir"). See "Packaging" below for the fix.

## Packaging (C00b)

`pnpm build` now bundles `src/main/index.ts`, `src/preload/index.ts` and
`src/main/pairing-preload.ts` into single CommonJS files under `dist/**`
with esbuild (`scripts/bundle.mjs`) — every workspace dependency
(`@montaj/bridge-core`, `@montaj/config`, `electron-updater`, `ws`,
`selfsigned`, `ulid`, `zod`; all pure JS, no native addons) is inlined; only
`electron` and Node builtins stay external. `scripts/bundle.mjs` also writes
a minimal, dependency-free `dist/package.json` (`name`/`version`/`main`
only).

`electron-builder.yml` points `directories.app` at that `dist/` tree instead
of the repo-managed `apps/desktop/package.json` (which lists
`workspace:*` deps that resolve to pnpm symlinks outside this app dir) —
electron-builder's own package.json/dependency lookup now runs against the
dependency-free `dist/package.json`, so it never touches a workspace
symlink and the `<file> must be under <appDir>` asar failure is gone.
`files: ["**/*"]` is relative to that app dir, so it means "everything in
`dist/`". `scripts/pack.mjs` wraps the `electron-builder` invocation to pass
`-c.extraMetadata.version`/`-c.extraMetadata.productName` sourced from this
package's own `package.json` version and `@montaj/config`'s `BRAND.name`,
so those values can never drift from `docs/CONTRACTS.md` §0's brand source
of truth. `pnpm pack:dry` (`pnpm build && node scripts/pack.mjs --dir`)
verifies this locally and prints the unpacked size of `release/win-unpacked`
(or `release/mac*/Aksharo.app` on macOS) — C10's size budget is ≤ 150 MB
(Windows).

`tools/release`'s `build-desktop` consumes this real `release/` output by
default (`findRealElectronBuilderOutput`) and falls back to the synthesized
placeholder tree only when no real output exists, or when `--placeholder`
is passed explicitly (used by the CI `dry-run` job, which never builds
`apps/desktop`).
