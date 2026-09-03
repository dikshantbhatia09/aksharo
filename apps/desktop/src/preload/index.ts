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
    pair: (pairingId: string) => ipcRenderer.invoke("desktop:bridge-pair", pairingId),
    deny: (pairingId: string) => ipcRenderer.invoke("desktop:bridge-deny", pairingId),
    provideAccessToken: (token: string) =>
      ipcRenderer.invoke("desktop:bridge-provide-access-token", token),
    onPairingRequested: (listener) => {
      const channel = "desktop:bridge-pairing-requested";
      const handler = (_event: Electron.IpcRendererEvent, pairing: unknown) =>
        listener(pairing as Parameters<typeof listener>[0]);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onClientConnected: (listener) => {
      const channel = "desktop:bridge-client-connected";
      const handler = (_event: Electron.IpcRendererEvent, client: unknown) =>
        listener(client as Parameters<typeof listener>[0]);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
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

  local: {
    isEnabled: () => ipcRenderer.invoke("desktop:local-is-enabled"),
    createProject: (input) => ipcRenderer.invoke("desktop:local-create-project", input),
    listProjects: () => ipcRenderer.invoke("desktop:local-list-projects"),
    openProject: (projectId: string) => ipcRenderer.invoke("desktop:local-open-project", projectId),
    deleteProject: (projectId: string) =>
      ipcRenderer.invoke("desktop:local-delete-project", projectId),
    importMedia: (input) => ipcRenderer.invoke("desktop:local-import-media", input),
    listMedia: (projectId: string) => ipcRenderer.invoke("desktop:local-list-media", projectId),
    transcribe: (input) => ipcRenderer.invoke("desktop:local-transcribe", input),
    align: (input) => ipcRenderer.invoke("desktop:local-align", input),
    saveEdgSnapshot: (input) => ipcRenderer.invoke("desktop:local-save-edg-snapshot", input),
    latestSnapshot: (projectId: string) =>
      ipcRenderer.invoke("desktop:local-latest-snapshot", projectId),
    runExport: (input) => ipcRenderer.invoke("desktop:local-run-export", input),
    listExports: (projectId: string) => ipcRenderer.invoke("desktop:local-list-exports", projectId),
  },
};

contextBridge.exposeInMainWorld("aksharoDesktop", api);
