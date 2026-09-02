# @montaj/desktop

Electron shell that loads the **hosted** Aksharo web app (decision D71 —
supersedes the "packaged web bundle" wording in `10-build-plan.md`: one web
codebase, instant updates; a packaged offline UI arrives only with local mode,
C04), with the local bridge embedded in-process, `electron-updater` channels,
native menus/tray and `aksharo://` deep links.

**Status:** implemented by **C02**. Local engine (C03a/b), local mode (C04)
and installers/marketplace (C10) are out of scope here.

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
  bridge: { pair(pairCode: string): Promise<{ ok: true } | { ok: false; error: string }> };
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

## Embedded bridge

`src/bridge/adapter.ts` defines `BridgeAdapter` (start/stop/approvePairing/
status) and ships `createStubBridgeAdapter()` because C01 ("Local bridge v2")
is still `briefed`, not merged. The tray and `bridge.pair` IPC handler are
wired against this interface; swap in the real `bridge-core`-backed adapter
when C01 lands (see Open questions in the C02 final report).

## Tests

- `vitest run` — allowlist, deep-link parsing, updater feed/rollout math, the
  bridge adapter stub. Pure-logic modules only; main/preload wiring needs a
  real Electron runtime.
- `pnpm test:e2e` (Playwright-Electron, `e2e/smoke.spec.ts`) — launch, offline
  page renders (forced via `AKSHARO_DESKTOP_TEST_APP_URL`, a test-only escape
  hatch gated on `app.isPackaged === false`), preload API present with no
  `ipcRenderer`/`process` leak into the page. Requires `pnpm build` first and
  a display (Xvfb on headless Linux CI).
- `pnpm pack:dry` — unsigned `electron-builder --dir` build (fuses hook
  included) for a packaging smoke check; real signing/notarisation/channels
  hosting is C00.
