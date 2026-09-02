import { cpus, freemem, homedir, totalmem } from "node:os";
import { join } from "node:path";

import { aksharoDir } from "@montaj/bridge-core";

import { FakeBackend } from "./backends/fake-backend.js";
import { detectBackend, type SystemInfo } from "./detection.js";
import {
  engineDiscoveryFilePath,
  generateBearerToken,
  removeEngineDiscoveryFile,
  writeEngineDiscoveryFile,
} from "./discovery.js";
import { defaultManifest } from "./manifest.js";
import { ModelManager } from "./model-manager.js";
import { startEngineServer } from "./server.js";

/**
 * Process entrypoint (brief §1). Excluded from the coverage threshold, same
 * as `apps/bridge/src/main.ts`, because it is process wiring exercised by a
 * future SEA/smoke test rather than by a unit test.
 *
 * **Backend selection today:** only `FakeBackend` is wired up (brief
 * "Reality": "tests run against a FakeBackend ... the real backends are
 * exercised by C03b on real machines"). `detectBackend()` still runs and is
 * reported over `/health`, so the desktop shell sees the real tier/backend
 * verdict for this machine even though the fake backend answers every
 * request — swapping in a real whisper.cpp/Silero/deep-filter-backed
 * `EngineBackend` (C03b) needs no change to this wiring beyond constructing
 * a different object here.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const modelsDir = process.env["ENGINE_MODELS_DIR"] || join(homedir(), ".aksharo", "models");
  const baseUrl = process.env["MODEL_WEIGHTS_BASE_URL"] || "https://models.aksharo.ai";

  const systemInfo: SystemInfo = {
    platform: process.platform,
    cores: cpus().length,
    ramGb: totalmem() / 1024 ** 3,
    hasMetal: process.platform === "darwin",
  };
  void freemem; // reserved for a future memory-pressure signal in the tier calc.
  const detection = detectBackend(systemInfo);

  const modelManager = new ModelManager({
    manifest: defaultManifest(),
    baseUrl,
    modelsDir,
    diskBudgetBytes: 5 * 1024 ** 3,
  });
  await modelManager.verifyAll();

  const backend = new FakeBackend();
  const bearer = generateBearerToken();

  const server = await startEngineServer({ bearer, backend, modelManager, detection, startedAt });

  const discoveryDir = process.env["ENGINE_DISCOVERY_DIR"];
  writeEngineDiscoveryFile(
    {
      port: server.port,
      bearer,
      pid: process.pid,
      version: "0.1.0",
      startedAt: new Date(startedAt).toISOString(),
    },
    discoveryDir === undefined ? undefined : engineDiscoveryFilePath(discoveryDir),
  );

  const shutdown = async (): Promise<void> => {
    removeEngineDiscoveryFile(discoveryDir === undefined ? undefined : engineDiscoveryFilePath(discoveryDir));
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // eslint-disable-next-line no-console -- process-level status line, not user data.
  console.log(
    JSON.stringify({
      evt: "engine.started",
      port: server.port,
      backend: backend.kind,
      tier: detection.tier,
      discoveryFile: aksharoDir(),
    }),
  );
}

main().catch((error: unknown) => {
   
  console.error(error);
  process.exit(1);
});
