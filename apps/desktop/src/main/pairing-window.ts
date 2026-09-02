/**
 * Pairing approval window (brief §2, ruling 2): a small, focused window
 * showing the pairing code, client name/kind, Approve/Deny buttons and a
 * 60s auto-deny countdown. This *is* the pairing-approval UX — the tray's
 * "Approve pairing…" menu item just re-shows this window if one is pending.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { BrowserWindow, ipcMain } from "electron";

import { offlinePageCsp } from "../security/csp.js";

import type { BridgeAdapter, BridgePendingPairing } from "../bridge/adapter.js";

const AUTO_DENY_MS = 60_000;
const PAIRING_HTML_PATH = path.join(__dirname, "pairing-approval.html");
const PAIRING_PRELOAD_PATH = path.join(__dirname, "pairing-preload.js");
const DECIDE_CHANNEL = "desktop:pairing-decide";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PairingWindowController {
  readonly pairingId: string;
  readonly window: BrowserWindow;
  /** Denies (if still pending) and closes the window. */
  close(): void;
}

/**
 * Shows the approval window for one pending pairing. Only one is ever shown
 * at a time (the adapter itself only tracks a single pending pairing), so a
 * fixed IPC channel is fine — decisions are matched to this window by
 * `event.sender` rather than a per-pairing channel name.
 */
export function showPairingApprovalWindow(
  pairing: BridgePendingPairing,
  bridge: Pick<BridgeAdapter, "approvePairing" | "denyPairing">,
): PairingWindowController {
  const deadline = new Date(Date.now() + AUTO_DENY_MS).toISOString();
  const html = readFileSync(PAIRING_HTML_PATH, "utf8")
    .replace("__CSP__", offlinePageCsp())
    .replace("__CODE__", escapeHtml(pairing.code))
    .replace("__CLIENT_NAME__", escapeHtml(pairing.clientName))
    .replace("__CLIENT_KIND__", escapeHtml(pairing.clientKind))
    .replace("__DEADLINE__", deadline);

  const win = new BrowserWindow({
    width: 420,
    height: 340,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Approve pairing",
    webPreferences: {
      preload: PAIRING_PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  let settled = false;

  const finish = (approved: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ipcMain.removeListener(DECIDE_CHANNEL, onDecide);
    const action = approved
      ? bridge.approvePairing(pairing.pairingId)
      : bridge.denyPairing(pairing.pairingId);
    action
      .catch(() => {
        // Already resolved/expired elsewhere (e.g. the bridge stopped); nothing more to do.
      })
      .finally(() => {
        if (!win.isDestroyed()) win.close();
      });
  };

  const onDecide = (event: Electron.IpcMainEvent, approved: boolean): void => {
    if (event.sender.id !== win.webContents.id) return;
    finish(approved);
  };
  ipcMain.on(DECIDE_CHANNEL, onDecide);

  const timer = setTimeout(() => finish(false), AUTO_DENY_MS);

  win.on("closed", () => {
    clearTimeout(timer);
    ipcMain.removeListener(DECIDE_CHANNEL, onDecide);
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  return {
    pairingId: pairing.pairingId,
    window: win,
    close: () => finish(false),
  };
}
