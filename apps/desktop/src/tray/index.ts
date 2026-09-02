/**
 * Tray icon + menu (brief §5): bridge/paired-client/engine status (read-only),
 * "Approve pairing", open app, check for updates, quit.
 */
import { Menu, Tray, app, nativeImage } from "electron";

import type { BridgeAdapter } from "../bridge/adapter.js";

export interface TrayDeps {
  bridge: BridgeAdapter;
  showWindow: () => void;
  checkForUpdates: () => void;
  /** Shows (or re-shows) the pairing approval window for the current pending request, if any. */
  approvePairingPrompt: () => void;
  /** Whether a pairing request is currently awaiting a decision (enables the menu item's label). */
  hasPendingPairing: () => boolean;
  copyDiagnostics: () => void;
  iconPath?: string;
}

export function createTray(deps: TrayDeps): Tray {
  const icon = deps.iconPath
    ? nativeImage.createFromPath(deps.iconPath)
    : nativeImage.createEmpty();
  const tray = new Tray(icon);
  tray.setToolTip("Aksharo");

  const rebuild = () => {
    const status = deps.bridge.getStatus();
    const statusLabel =
      status.status === "running"
        ? `Bridge running${status.port ? ` (port ${status.port})` : ""} · ${status.pairedClients.length} paired`
        : status.status === "error"
          ? `Bridge unavailable${status.error ? `: ${status.error}` : ""}`
          : `Bridge ${status.status}`;

    const pending = deps.hasPendingPairing();
    const menu = Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: "separator" },
      { label: "Open Aksharo", click: () => deps.showWindow() },
      {
        label: pending ? "Approve pairing…" : "Approve pairing (none pending)",
        enabled: pending,
        click: () => deps.approvePairingPrompt(),
      },
      { label: "Check for updates", click: () => deps.checkForUpdates() },
      { label: "Copy diagnostics", click: () => deps.copyDiagnostics() },
      { type: "separator" },
      { label: "Quit", role: "quit", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  };

  rebuild();
  deps.bridge.onStatusChange(rebuild);
  deps.bridge.onPairingRequested(rebuild);
  deps.bridge.onClientConnected(rebuild);
  return tray;
}
