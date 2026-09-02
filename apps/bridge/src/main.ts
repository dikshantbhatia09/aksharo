import { BridgeCore } from "@montaj/bridge-core";

import { loadConfig } from "./config.js";
import { createNativeTray } from "./native-tray.js";

/**
 * `apps/bridge` entry point: the Node SEA (brief §5). Everything the bridge
 * actually does lives in `@montaj/bridge-core`; this file only reads local
 * config, wires up logging, and handles process lifecycle — the native tray
 * (`native-tray.ts`, documented choice: see `apps/bridge/README.md`) attaches
 * to `BridgeCore` events the same way the console fallback tray does; when a
 * native tray cannot be shown (headless, no display, missing helper binary)
 * `BridgeCore` itself falls back to its own console tray.
 *
 * Crash-safe restart: `apps/bridge` itself does not respawn on crash (that is
 * the OS service manager's job — Windows Task Scheduler / launchd, wired by
 * C00's installer); this file's own job is to exit non-zero on an unrecovered
 * error so the service manager's restart policy has a real signal.
 */

function log(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  const tray = await createNativeTray({
    log: (line) => log({ evt: "bridge.tray", line }),
  }).catch((error: unknown) => {
    log({ evt: "bridge.tray_error", message: error instanceof Error ? error.message : String(error) });
    return undefined;
  });
  if (tray === undefined) {
    log({ evt: "bridge.tray", line: "no native tray available; using console fallback" });
  }

  const bridge = new BridgeCore({
    ...(config.relayUrl !== undefined ? { relayUrl: config.relayUrl } : {}),
    ...(config.deviceToken !== undefined ? { deviceToken: config.deviceToken } : {}),
    ...(tray !== undefined ? { tray } : {}),
    log,
  });

  bridge.on("status", (event) => {
    log({ evt: "bridge.status", ...event });
    tray?.setStatus(event.status);
  });
  bridge.on("pairingRequested", (pairingId, clientName) => {
    log({ evt: "bridge.pairing_requested", pairingId, clientName });
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ evt: "bridge.shutdown", signal });
    void Promise.allSettled([bridge.stop(), tray?.close() ?? Promise.resolve()]).then(() =>
      process.exit(0),
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  tray?.onQuitRequested(() => shutdown("tray-quit"));

  await bridge.start();
  log({ evt: "bridge.ready", discoveryPath: bridge.discoveryPath() });
}

main().catch((error: unknown) => {
  log({ evt: "bridge.fatal", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
