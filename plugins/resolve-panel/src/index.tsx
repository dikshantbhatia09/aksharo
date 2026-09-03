/**
 * Production entry point: the only other file (besides `src/host/workflow-integration.ts`'s
 * `createRealWorkflowIntegrationHost` and `src/rpc/wsTransport.ts`'s `createWebSocketTransport`)
 * allowed to touch a real host/browser global. Excluded from the coverage gate
 * (`vitest.config.ts`), same as `plugins/premiere-uxp/src/index.tsx`.
 */
import { createRoot } from "react-dom/client";

import { createRealWorkflowIntegrationHost } from "./host/workflow-integration.js";
import { createWebSocketTransport } from "./rpc/wsTransport.js";
import { App } from "./ui/App.js";
import { evaluateUpdateBanner } from "./version/manifestCheck.js";

const PANEL_VERSION = "0.1.0";

async function main(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) throw new Error("resolve-panel: #root not found");

  const host = createRealWorkflowIntegrationHost();

  // GATE-C: `/plugins/manifest` fetch is not wired yet (no confirmed API origin config for
  // this panel); ships with the "no banner" default until that lands.
  const updateBannerState = evaluateUpdateBanner(PANEL_VERSION, {
    minVersion: PANEL_VERSION,
    maxVersion: PANEL_VERSION,
    latestVersion: PANEL_VERSION,
  });

  createRoot(container).render(
    <App
      host={host}
      createTransport={createWebSocketTransport}
      panelVersion={PANEL_VERSION}
      apiVersion="0.1.0"
      updateBannerState={updateBannerState}
      projectId=""
      languageHints={["hi-Latn", "hi", "en-IN", "en"]}
    />,
  );
}

void main();
