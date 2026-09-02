/**
 * Preload script (brief §1-2): runs with `contextIsolation: true`,
 * `nodeIntegration: false`, `sandbox: true`. Exposes only the allowlisted,
 * typed `window.aksharoDesktop` surface via `contextBridge` — no raw
 * `ipcRenderer`, no Node globals reach the page.
 */
import { contextBridge, ipcRenderer } from "electron";

import type { AksharoDesktopApi } from "./api-types.js";

const api: AksharoDesktopApi = {
  version: process.env.npm_package_version ?? "0.0.0",
  platform: process.platform,

  openMediaDialog: () => ipcRenderer.invoke("desktop:open-media-dialog") as Promise<string[]>,

  engine: {
    status: () => ipcRenderer.invoke("desktop:engine-status"),
  },

  bridge: {
    pair: (pairCode: string) => ipcRenderer.invoke("desktop:bridge-pair", pairCode),
  },

  updates: {
    check: () => ipcRenderer.invoke("desktop:updates-check"),
  },

  deepLink: {
    onOpen: (listener: (url: string) => void) => {
      const channel = "desktop:deep-link";
      const handler = (_event: Electron.IpcRendererEvent, url: string) => listener(url);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },

  telemetry: {
    getConsent: () => ipcRenderer.invoke("desktop:telemetry-get-consent"),
    setConsent: (granted: boolean) => ipcRenderer.invoke("desktop:telemetry-set-consent", granted),
    drainQueuedEvents: (limit: number) =>
      ipcRenderer.invoke("desktop:telemetry-drain-queue", limit),
    buildDiagnosticsBundle: () => ipcRenderer.invoke("desktop:telemetry-build-diagnostics-bundle"),
  },
};

contextBridge.exposeInMainWorld("aksharoDesktop", api);
