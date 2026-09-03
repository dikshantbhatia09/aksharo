/**
 * CEP panel entry point (`CSXS/manifest.xml`'s `MainPath` -> `index.html` -> this bundle).
 * Wires the real host/bridge/http implementations to `App`. Excluded from the coverage gate
 * (`vitest.config.ts`) since it only does DOM mounting and environment wiring.
 *
 * GATE C: `createRealAeHost()`'s every method throws until a human runs `docs/GATE-C-CHECKLIST.md`
 * against a real After Effects install (see `src/host/ae.ts`). The bridge base URL/token below
 * should come from the discovery file bridge-core writes (`bridge.json`, 0600, port/pid/token)
 * once C02/C01 exposes a way for a CEP panel to read it — open question, same one C05a's
 * `index.tsx` flags for the Premiere panel, not solved here.
 */
import { createRoot } from "react-dom/client";

import { BridgeClient } from "./bridge/client.js";
import { FetchHttpClient, HttpBridgeTransport } from "./bridge/httpTransport.js";
import { createRealAeHost } from "./host/ae.js";
import { App } from "./ui/App.js";

const PANEL_VERSION = "0.1.0";

// Placeholder loopback defaults (47831, the first port in the C01 ladder). Real wiring reads
// `bridge.json`'s port/token once the panel<->discovery-file bridge exists (see header note).
const bridgeTransport = new HttpBridgeTransport({
  baseUrl: "https://127.0.0.1:47831",
  bearerToken: "",
});
const bridge = new BridgeClient(bridgeTransport);
const http = new FetchHttpClient();
const host = createRealAeHost();

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <App
      host={host}
      bridge={bridge}
      http={http}
      apiOrigin="https://api.aksharo.ai"
      webOrigin="https://aksharo.ai"
      panelVersion={PANEL_VERSION}
    />,
  );
}
