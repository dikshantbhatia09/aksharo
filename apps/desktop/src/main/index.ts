/**
 * Main process entry point (brief §1-7). Loads the hosted web app (D71),
 * enforces the navigation/popup/openExternal allowlists, registers the
 * `aksharo://` deep-link scheme, wires electron-updater, and hosts the tray
 * and the (stubbed, pending C01) embedded bridge.
 */
import { readFileSync } from "node:fs";
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

import { BRAND } from "@montaj/config/brand";

import { buildAppMenu } from "./menu.js";
import { showPairingApprovalWindow, type PairingWindowController } from "./pairing-window.js";
import { createBridgeAdapter, createStubBridgeAdapter } from "../bridge/adapter.js";
import { bootstrapDevice } from "../bridge/device-bootstrap.js";
import { parseDeepLink } from "../deeplink/parse.js";
import {
  APP_ORIGIN,
  decidePopup,
  isNavigationAllowed,
  isOpenExternalAllowed,
} from "../security/allowlist.js";
import { offlinePageCsp } from "../security/csp.js";
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
