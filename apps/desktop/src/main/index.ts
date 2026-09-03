/**
 * Main process entry point (brief §1-7). Loads the hosted web app (D71),
 * enforces the navigation/popup/openExternal allowlists, registers the
 * `aksharo://` deep-link scheme, wires electron-updater, and hosts the tray
 * and the (stubbed, pending C01) embedded bridge.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BrowserWindow,
  Menu,
  type Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  session,
  shell,
} from "electron";
import { autoUpdater } from "electron-updater";

import { discoveryFilePath } from "@montaj/bridge-core";
import type { PlanTier } from "@montaj/config";
import { BRAND } from "@montaj/config/brand";

import { buildAppMenu } from "./menu.js";
import { showPairingApprovalWindow, type PairingWindowController } from "./pairing-window.js";
import { createBridgeAdapter, createStubBridgeAdapter } from "../bridge/adapter.js";
import { bootstrapDevice } from "../bridge/device-bootstrap.js";
import { parseDeepLink } from "../deeplink/parse.js";
import { openLocalDb } from "../local/db.js";
import { connectToLocalEngine } from "../local/engine-connection.js";
import { createLocalModeGate } from "../local/entitlement-gate.js";
import {
  ALT_API_ORIGIN,
  API_ORIGIN,
  isUploadBlocked,
  createLocalModeState,
} from "../local/network-guard.js";
import { LocalStore } from "../local/store.js";
import {
  APP_ORIGIN,
  decidePopup,
  isNavigationAllowed,
  isOpenExternalAllowed,
} from "../security/allowlist.js";
import { offlinePageCsp } from "../security/csp.js";
import { createConsentStore, type ConsentFileIO } from "../telemetry/consent-store.js";
import { buildCrashPayload } from "../telemetry/crash-handler.js";
import { buildDiagnosticsBundle } from "../telemetry/diagnostics-bundle.js";
import { createLogRingBuffer } from "../telemetry/log-ring-buffer.js";
import { createFileBackedQueue, type QueueFileIO } from "../telemetry/offline-queue.js";
import { createTray } from "../tray/index.js";
import { feedUrl, isUpdateChannel, type UpdateChannel } from "../updater/feed.js";

import type { BridgeAdapter, BridgePendingPairing } from "../bridge/adapter.js";

const OFFLINE_RETRY_SCHEME = "aksharo-offline-retry";
const PRELOAD_PATH = path.join(__dirname, "..", "preload", "index.js");
const OFFLINE_HTML_PATH = path.join(__dirname, "offline.html");

/** Test-only escape hatch, gated on `app.isPackaged === false` (same pattern as
 * `AKSHARO_DESKTOP_TEST_APP_URL`) so the device-bootstrap flow can be pointed at a
 * fixture API in tests without a live network dependency. */
function apiOrigin(): string {
  const testOverride = process.env.AKSHARO_DESKTOP_TEST_API_URL;
  return testOverride && app.isPackaged === false ? testOverride : `https://api.${BRAND.domain}`;
}

let mainWindow: BrowserWindow | null = null;
let updateChannel: UpdateChannel = "stable";
let tray: Tray | null = null;
let pairingWindow: PairingWindowController | null = null;
let pendingPairing: BridgePendingPairing | null = null;
let accessToken: string | undefined;
let bridge: BridgeAdapter = createStubBridgeAdapter();

// --- C04: local mode --------------------------------------------------------
let localStore: LocalStore | null = null;
const localModeGate = createLocalModeGate();
const localModeState = createLocalModeState();

function requireLocalStore(): LocalStore {
  if (!localModeGate.isEnabled()) {
    throw new Error("local/disabled: this workspace's plan does not include local mode");
  }
  if (localStore === null) throw new Error("local/not_ready: the local store has not started yet");
  return localStore;
}

/**
 * Wires the tray/approval-window/renderer surfaces to whichever `BridgeAdapter`
 * is currently active (brief §1, §2). Called once for the initial stub
 * adapter and again after `attachRealBridge` swaps in the real one, so a
 * restart-free upgrade from "bridge unavailable" to "bridge running" is
 * possible once the user signs in and a device credential is minted.
 */
function wireBridgeEvents(adapter: BridgeAdapter): void {
  adapter.onPairingRequested((pairing) => {
    pendingPairing = pairing;
    mainWindow?.webContents.send("desktop:bridge-pairing-requested", pairing);
    pairingWindow?.close();
    pairingWindow = showPairingApprovalWindow(pairing, adapter);
    pairingWindow.window.on("closed", () => {
      if (pendingPairing?.pairingId === pairing.pairingId) pendingPairing = null;
      pairingWindow = null;
    });
  });
  adapter.onClientConnected((client) => {
    mainWindow?.webContents.send("desktop:bridge-client-connected", client);
  });
}

/**
 * Device bootstrap (brief §2, B08/B08b): once the hosted web app hands down a
 * signed-in user's access token (`desktop:bridge-access-token` IPC — the web
 * side of that hand-off is out of this WP's `apps/desktop/**` boundary),
 * registers this device and mints a bridge token, then swaps the stub
 * adapter for the real one and starts it. Safe to call more than once (e.g.
 * a token refresh); `bootstrapDevice` itself is idempotent via its keystore
 * cache. Never logs the access or device token in plaintext.
 */
async function attachRealBridge(token: string): Promise<void> {
  accessToken = token;
  let credential: Awaited<ReturnType<typeof bootstrapDevice>>;
  try {
    credential = await bootstrapDevice({
      apiOrigin: apiOrigin(),
      deviceName: os.hostname(),
      platform: process.platform,
      appVersion: app.getVersion(),
      getAccessToken: () => accessToken,
      log: (line) => console.warn(JSON.stringify(line)),
    });
  } catch (err) {
    console.error("device bootstrap failed", err instanceof Error ? err.message : err);
    return;
  }
  if (credential === undefined) return; // not signed in (yet)

  await bridge.stop().catch(() => undefined);
  bridge = createBridgeAdapter({
    relayUrl: `wss://api.${BRAND.domain}/bridge/relay`,
    deviceToken: credential.deviceToken,
    log: (line) => console.warn(JSON.stringify(line)),
  });
  wireBridgeEvents(bridge);
  await bridge.start();
  rebuildTray();
}

function rebuildTray(): void {
  tray?.destroy();
  tray = createTray({
    bridge,
    showWindow: () => {
      if (!mainWindow) {
        mainWindow = createMainWindow();
        return;
      }
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    },
    checkForUpdates: () => void autoUpdater.checkForUpdates().catch(() => undefined),
    approvePairingPrompt: () => {
      if (pendingPairing === null) return;
      pairingWindow?.window.show();
      pairingWindow?.window.focus();
    },
    hasPendingPairing: () => pendingPairing !== null,
    copyDiagnostics: () => {
      const status = bridge.getStatus();
      clipboard.writeText(
        JSON.stringify(
          {
            version: app.getVersion(),
            platform: process.platform,
            channel: updateChannel,
            bridge: status,
          },
          null,
          2,
        ),
      );
    },
  });
}

// --- C12: consent-gated telemetry -------------------------------------------
// The main process owns the local consent mirror, the offline event queue and
// crash capture (it can run before any renderer/web session exists); the
// hosted web app (already holding the user's access token) is the one that
// actually calls the API — see `preload/api-types.ts`'s `telemetry` doc comment.
const fsIo: ConsentFileIO & QueueFileIO = {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  readText: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
  writeText: (p, content) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    mkdirSync(path.dirname(p), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    writeFileSync(p, content, "utf8");
  },
};
const consentStore = createConsentStore(
  path.join(app.getPath("userData"), "telemetry-consent.json"),
  fsIo,
);
const telemetryQueue = createFileBackedQueue(
  path.join(app.getPath("userData"), "telemetry-queue.json"),
  fsIo,
);
const telemetryLogs = createLogRingBuffer();

function loadAppUrl(): string {
  // Test-only escape hatch so the Playwright-Electron smoke suite can force
  // the offline path deterministically without a live network dependency;
  // never read outside of the `test:e2e` suite, and never a substitute for
  // the navigation allowlist (which still governs where the window may go
  // after this initial load).
  const testOverride = process.env.AKSHARO_DESKTOP_TEST_APP_URL;
  const url = new URL(testOverride && app.isPackaged === false ? testOverride : APP_ORIGIN);
  url.searchParams.set("desktop", "1");
  return url.toString();
}

function showOfflinePage(win: BrowserWindow): void {
  const html = readFileSync(OFFLINE_HTML_PATH, "utf8").replace("__CSP__", offlinePageCsp());
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function attachNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const decision = decidePopup(url);
    if (decision === "controlled-window") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
          autoHideMenuBar: true,
        },
      };
    }
    if (decision === "external-browser" && isOpenExternalAllowed(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${OFFLINE_RETRY_SCHEME}:`)) {
      event.preventDefault();
      win.loadURL(loadAppUrl()).catch(() => showOfflinePage(win));
      return;
    }
    if (!isNavigationAllowed(url)) {
      event.preventDefault();
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, _desc, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3 /* ERR_ABORTED, e.g. user-initiated navigation */) {
      showOfflinePage(win);
    }
  });
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.webContents.setUserAgent(
    `${win.webContents.getUserAgent()} AksharoDesktop/${app.getVersion()}`,
  );
  attachNavigationGuards(win);
  win.once("ready-to-show", () => win.show());
  win.loadURL(loadAppUrl()).catch(() => showOfflinePage(win));
  win.on("closed", () => {
    mainWindow = null;
  });
  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle("desktop:open-media-dialog", async () => {
    if (!mainWindow) return [];
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Media", extensions: ["mp4", "mov", "mkv", "wav", "mp3", "m4a"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("desktop:engine-status", async () => ({ state: "unavailable" }) as const);

  ipcMain.handle("desktop:bridge-pair", async (_event, pairingId: string) => {
    try {
      await bridge.approvePairing(pairingId);
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "bridge pairing failed",
      };
    }
  });

  ipcMain.handle("desktop:bridge-deny", async (_event, pairingId: string) => {
    try {
      await bridge.denyPairing(pairingId);
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "bridge pairing denial failed",
      };
    }
  });

  // Hand-off from the hosted web app (running in `mainWindow`, already signed
  // in): the one bit the desktop shell needs to bootstrap its own device/
  // bridge-token (brief §2). Never returns or logs the token itself.
  ipcMain.handle("desktop:bridge-provide-access-token", async (_event, token: string) => {
    await attachRealBridge(token);
    return { ok: true as const };
  });

  ipcMain.handle("desktop:updates-check", async () => {
    const result = await autoUpdater.checkForUpdates().catch(() => null);
    return {
      channel: updateChannel,
      available: Boolean(result?.updateInfo),
      version: result?.updateInfo?.version,
    };
  });

  // --- C12 --------------------------------------------------------------
  ipcMain.handle("desktop:telemetry-get-consent", () => consentStore.get());
  ipcMain.handle("desktop:telemetry-set-consent", (_event, granted: boolean) => {
    if (!granted) telemetryQueue.clear(); // withdrawal takes effect immediately.
    return consentStore.set(granted);
  });
  ipcMain.handle("desktop:telemetry-drain-queue", (_event, limit: number) =>
    telemetryQueue.drain(limit),
  );
  // --- C04: local mode ----------------------------------------------------
  ipcMain.handle("desktop:local-set-plan", (_event, plan: PlanTier) => {
    localModeGate.setPlan(plan);
    return { ok: true as const };
  });
  ipcMain.handle("desktop:local-is-enabled", () => localModeGate.isEnabled());
  ipcMain.handle(
    "desktop:local-create-project",
    async (_event, input: { title: string; aspect: string }) => {
      const project = await requireLocalStore().createProject(input);
      localModeState.setActive(true);
      return project;
    },
  );
  ipcMain.handle("desktop:local-list-projects", () => requireLocalStore().listProjects());
  ipcMain.handle("desktop:local-open-project", (_event, projectId: string) => {
    const project = requireLocalStore().openProject(projectId);
    localModeState.setActive(true);
    return project;
  });
  ipcMain.handle("desktop:local-delete-project", async (_event, projectId: string) => {
    await requireLocalStore().deleteProject(projectId);
    return { ok: true as const };
  });
  ipcMain.handle(
    "desktop:local-import-media",
    (_event, input: Parameters<LocalStore["importMedia"]>[0]) =>
      requireLocalStore().importMedia(input),
  );
  ipcMain.handle("desktop:local-list-media", (_event, projectId: string) =>
    requireLocalStore().listMedia(projectId),
  );
  ipcMain.handle(
    "desktop:local-transcribe",
    (_event, input: Parameters<LocalStore["transcribe"]>[0]) =>
      requireLocalStore().transcribe(input),
  );
  ipcMain.handle("desktop:local-align", (_event, input: Parameters<LocalStore["align"]>[0]) =>
    requireLocalStore().align(input),
  );
  ipcMain.handle(
    "desktop:local-save-edg-snapshot",
    (_event, input: Parameters<LocalStore["saveEdgSnapshot"]>[0]) =>
      requireLocalStore().saveEdgSnapshot(input),
  );
  ipcMain.handle("desktop:local-latest-snapshot", (_event, projectId: string) =>
    requireLocalStore().latestSnapshot(projectId),
  );
  ipcMain.handle(
    "desktop:local-run-export",
    (_event, input: Parameters<LocalStore["runExport"]>[0]) => requireLocalStore().runExport(input),
  );
  ipcMain.handle("desktop:local-list-exports", (_event, projectId: string) =>
    requireLocalStore().listExports(projectId),
  );

  ipcMain.handle("desktop:telemetry-build-diagnostics-bundle", () => {
    const zip = buildDiagnosticsBundle({
      appVersion: app.getVersion(),
      platform: process.platform,
      osVersion: `${os.type()} ${os.release()}`,
      updateChannel,
      logLines: telemetryLogs.lines(),
      config: { channel: updateChannel },
      bridgeDiscovery: readBridgeDiscovery(),
    });
    return zip.toString("base64");
  });
}

/** The bridge discovery file's contents (`@montaj/bridge-core`), if present. */
function readBridgeDiscovery(): Record<string, unknown> | undefined {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
    const raw = readFileSync(discoveryFilePath(), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Installs the crash handler (brief §2). Only ever queues a redacted payload
 * — via `consentStore`, so nothing is queued before consent is granted — and
 * never rethrows or exits the process itself.
 */
function installTelemetryCrashHandler(): void {
  const onCrash = (payload: ReturnType<typeof buildCrashPayload>) => {
    if (!consentStore.get().granted) return;
    telemetryQueue.enqueue({
      eventId: `crash-${String(Date.now())}-${Math.random().toString(36).slice(2)}`,
      kind: "app_crashed",
      at: new Date().toISOString(),
      appVersion: app.getVersion(),
      props: payload as unknown as Record<string, unknown>,
    });
  };

  process.on("uncaughtException", (error) => {
    onCrash(
      buildCrashPayload(error, {
        appVersion: app.getVersion(),
        osVersion: `${os.type()} ${os.release()}`,
        logs: telemetryLogs,
      }),
    );
  });
  process.on("unhandledRejection", (reason) => {
    const error =
      reason instanceof Error ? reason : { message: `Unhandled rejection: ${String(reason)}` };
    onCrash(
      buildCrashPayload(error, {
        appVersion: app.getVersion(),
        osVersion: `${os.type()} ${os.release()}`,
        logs: telemetryLogs,
      }),
    );
  });
}

function dispatchDeepLink(rawUrl: string): void {
  const link = parseDeepLink(rawUrl);
  if (!link) return; // unknown/invalid route: ignore, never best-effort navigate
  if (!mainWindow) return;
  mainWindow.webContents.send("desktop:deep-link", rawUrl);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

function configureUpdater(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.channel = updateChannel;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: feedUrl(updateChannel),
    channel: updateChannel,
  });

  autoUpdater.on("update-available", () => {
    mainWindow?.webContents.send("desktop:update-available");
  });
  autoUpdater.on("update-downloaded", () => {
    mainWindow?.webContents.send("desktop:update-downloaded");
  });
}

export function setUpdateChannel(channel: string): void {
  if (!isUpdateChannel(channel)) return;
  updateChannel = channel;
  configureUpdater();
}

function configureSession(): void {
  // Strict default CSP applies to the offline page only; the hosted app sets
  // its own response headers (A13). This adds a floor so a compromised CDN
  // response can't relax the offline document beyond `default-src 'none'`.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith("data:text/html")) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [offlinePageCsp()],
        },
      });
      return;
    }
    callback({ responseHeaders: details.responseHeaders });
  });

  // C04 §2: no uploads of any kind while a local project is open. Runs in the
  // main process against every request the renderer makes — see
  // `local/network-guard.ts`'s doc comment for why this is not a preload
  // `fetch` patch.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (
      isUploadBlocked(
        { method: details.method, url: details.url },
        { localModeActive: localModeState.isActive(), apiOrigins: [API_ORIGIN, ALT_API_ORIGIN] },
      )
    ) {
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });
}

/** Starts the local store (brief C04 §1): SQLite for metadata under `userData`, media files alongside it. */
async function bootstrapLocalStore(): Promise<void> {
  const db = await openLocalDb(path.join(app.getPath("userData"), "local.sqlite3"));
  const mediaDir = path.join(app.getPath("userData"), "local-media");
  const engine = connectToLocalEngine();
  localStore = new LocalStore({ db, mediaDir, engine });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows/Linux deep-link hand-off: the OS launches a second instance
    // with the URL as an argv entry.
    const url = argv.find((arg) => arg.startsWith(`${BRAND.deepLinkScheme}://`));
    if (url) dispatchDeepLink(url);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("open-url", (event, url) => {
    // macOS deep-link hand-off.
    event.preventDefault();
    dispatchDeepLink(url);
  });

  app.whenReady().then(() => {
    app.setAsDefaultProtocolClient(BRAND.deepLinkScheme);
    configureSession();
    registerIpcHandlers();
    void bootstrapLocalStore().catch((err) =>
      console.error("local store bootstrap failed", err instanceof Error ? err.message : err),
    );
    installTelemetryCrashHandler();
    Menu.setApplicationMenu(buildAppMenu(`https://${BRAND.domain}/support`));
    mainWindow = createMainWindow();
    configureUpdater();
    wireBridgeEvents(bridge);
    rebuildTray();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
}
