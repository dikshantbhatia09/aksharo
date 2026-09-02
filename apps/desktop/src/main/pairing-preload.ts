/**
 * Preload script for the pairing approval window only (`pairing-window.ts`).
 * Runs with `contextIsolation: true`, `nodeIntegration: false`,
 * `sandbox: true`, exactly like the main hosted-app preload — this is a
 * separate, narrower surface (`window.pairingApproval.decide`) for a
 * trusted, locally-generated window, never reachable by the hosted web app
 * (THREAT-MODEL T25: no new privileges on the main renderer).
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pairingApproval", {
  decide: (approved: boolean) => ipcRenderer.send("desktop:pairing-decide", approved),
});
