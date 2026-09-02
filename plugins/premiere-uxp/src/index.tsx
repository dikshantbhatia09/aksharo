/**
 * UXP panel entry point (`manifest.json`'s `main` -> `index.html` -> this bundle). Wires the
 * real host/bridge/http implementations to `App`. Excluded from the coverage gate
 * (`vitest.config.ts`) since it only does DOM mounting and environment wiring, nothing this
 * package's tests can meaningfully assert without a real UXP host.
 *
 * GATE-C: `createRealPremiereHost()`'s `requestMixdown`/`readFile` throw until the A00-03
 * spike confirms the underlying EncoderManager/file-system calls (see `src/host/premiere.ts`).
 * The bridge base URL/token below should come from the discovery file bridge-core writes
 * (`bridge.json`, 0600, port/pid/token) once C02/C01 exposes a way for a UXP panel (which has
 * no Node `fs`) to read it — tracked as an open question in the WP report, not solved here.
 */
import { createRoot } from "react-dom/client";

import { BridgeClient } from "./bridge/client.js";
import { FetchHttpClient, HttpBridgeTransport } from "./bridge/httpTransport.js";
import { createRealPremiereHost } from "./host/premiere.js";
import { App } from "./ui/App.js";
import { evaluateUpdateBanner } from "./version/manifestCheck.js";

const PANEL_VERSION = "0.1.0";
const API_VERSION = "1";

// Placeholder loopback defaults (47831, the first port in the C01 ladder). Real wiring reads
// `bridge.json`'s port/token once the panel<->discovery-file bridge exists (see header note).
const bridgeTransport = new HttpBridgeTransport({
  baseUrl: "https://127.0.0.1:47831",
  bearerToken: "",
});
const bridge = new BridgeClient(bridgeTransport);
const http = new FetchHttpClient();
const host = createRealPremiereHost();

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
      apiVersion={API_VERSION}
      activationState="unknown"
      updateBannerState={evaluateUpdateBanner(PANEL_VERSION, {
        minVersion: "0.1.0",
        maxVersion: "9.9.9",
        latestVersion: PANEL_VERSION,
      })}
    />,
  );
}
