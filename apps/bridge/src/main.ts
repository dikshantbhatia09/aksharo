import { hostname, platform as osPlatform, release as osRelease, type as osType } from "node:os";

import { BridgeCore } from "@montaj/bridge-core";

import { loadConfig, saveConfig } from "./config.js";
import { fetchTelemetryConsent, startConsentPolling } from "./consent-sync.js";
import {
  bootstrapDeviceCredentials,
  DeviceAuthError,
  refreshDeviceCredentials,
} from "./device-auth.js";
import { createNativeTray } from "./native-tray.js";
import { createTelemetryClient } from "./telemetry/client.js";

import type { BridgeAppConfig } from "./config.js";
import type { TelemetryClient } from "./telemetry/client.js";

/** Read from `package.json` at build time by `scripts/build-sea.mjs`; a plain literal here otherwise. */
const APP_VERSION = process.env["npm_package_version"] ?? "0.0.0";

/** How often `main()` re-reads `GET /consents` after startup (M04, C12 follow-up). */
const CONSENT_POLL_INTERVAL_MS = 5 * 60_000;

/**
 * `apps/bridge` entry point: the Node SEA (brief §5). Everything the bridge
 * actually does lives in `@montaj/bridge-core`; this file only reads local
 * config, obtains this install's own credential (B08b's device-code +
 * registration bootstrap, `device-auth.ts`), wires up logging, and handles
 * process lifecycle — the native tray (`native-tray.ts`, documented choice:
 * see `apps/bridge/README.md`) attaches to `BridgeCore` events the same way
 * the console fallback tray does; when a native tray cannot be shown
 * (headless, no display, missing helper binary) `BridgeCore` itself falls
 * back to its own console tray.
 *
 * Crash-safe restart: `apps/bridge` itself does not respawn on crash (that is
 * the OS service manager's job — Windows Task Scheduler / launchd, wired by
 * C00's installer); this file's own job is to exit non-zero on an unrecovered
 * error so the service manager's restart policy has a real signal.
 */

function log(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...line })}\n`);
}

/** A machine-stable id for `POST /devices/register`'s `fingerprint`. */
function fingerprint(config: BridgeAppConfig): string {
  return `bridge:${hostname()}:${config.deviceId ?? "new"}`;
}

/**
 * Ensures `config.deviceToken` is a live `kind:"bridge"` credential, bootstrapping
 * a new device on first run (or once a stored refresh token is no longer good
 * for anything) and otherwise just re-minting the bridge token from the device
 * already on file. Always persists what it obtains via `saveConfig`.
 */
async function ensureDeviceToken(
  config: BridgeAppConfig,
  apiOrigin: string,
): Promise<BridgeAppConfig> {
  const fresh =
    config.deviceToken !== undefined &&
    config.deviceTokenExpiresAt !== undefined &&
    config.deviceTokenExpiresAt > Date.now() + 60_000;
  if (fresh) return config;

  if (config.deviceId !== undefined && config.sessionRefreshToken !== undefined) {
    try {
      const refreshed = await refreshDeviceCredentials(
        apiOrigin,
        config.deviceId,
        config.sessionRefreshToken,
      );
      const next: BridgeAppConfig = {
        ...config,
        apiOrigin,
        deviceToken: refreshed.bridgeToken,
        sessionRefreshToken: refreshed.sessionRefreshToken,
        deviceTokenExpiresAt: refreshed.bridgeTokenExpiresAt,
      };
      saveConfig(next);
      return next;
    } catch (error) {
      log({
        evt: "bridge.device_token_refresh_failed",
        message: error instanceof DeviceAuthError ? error.message : String(error),
      });
      // Falls through to a fresh device-code sign-in: the stored refresh
      // token is no longer good for anything (revoked device, expired
      // session), so there is nothing left to refresh.
    }
  }

  const credentials = await bootstrapDeviceCredentials({
    apiOrigin,
    fingerprint: fingerprint(config),
    name: hostname(),
    platform: osPlatform(),
    onPairingCode: (info) => {
      log({
        evt: "bridge.pairing_code",
        userCode: info.userCode,
        approveAt: info.verificationUrlComplete,
        expiresIn: info.expiresIn,
      });
    },
  });
  const next: BridgeAppConfig = {
    ...config,
    apiOrigin,
    deviceId: credentials.deviceId,
    deviceToken: credentials.bridgeToken,
    sessionRefreshToken: credentials.sessionRefreshToken,
    deviceTokenExpiresAt: credentials.bridgeTokenExpiresAt,
  };
  saveConfig(next);
  return next;
}

async function main(): Promise<void> {
  let config = loadConfig();
  if (config.relayUrl !== undefined) {
    const apiOrigin = config.apiOrigin ?? relayUrlToApiOrigin(config.relayUrl);
    try {
      config = await ensureDeviceToken(config, apiOrigin);
    } catch (error) {
      log({
        evt: "bridge.device_auth_failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  const tray = await createNativeTray({
    log: (line) => log({ evt: "bridge.tray", line }),
  }).catch((error: unknown) => {
    log({
      evt: "bridge.tray_error",
      message: error instanceof Error ? error.message : String(error),
    });
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

  // C12: consent-gated telemetry. Best-effort, fire-and-forget (see
  // `telemetry/client.ts`'s doc comment) — never lets a telemetry failure
  // affect the bridge's own start/stop/pairing behaviour.
  //
  // `telemetryRef.client` is set/cleared, not fixed at startup, so a consent
  // change picked up later (`consent-sync.ts`'s poll) takes effect without a
  // restart: the crash/rejection handlers below and the `bridge_connected`
  // report both read `telemetryRef.client` at the moment they fire.
  const apiOrigin = config.apiOrigin ?? relayUrlToApiOrigin(config.relayUrl ?? "");
  const telemetryRef: { client?: TelemetryClient } = {};
  function applyTelemetryConsent(granted: boolean): void {
    if (granted && config.deviceToken !== undefined) {
      telemetryRef.client = createTelemetryClient({
        apiOrigin,
        deviceToken: config.deviceToken,
        appVersion: APP_VERSION,
      });
    } else {
      telemetryRef.client = undefined;
    }
  }

  if (config.deviceToken !== undefined) {
    // Refresh from the server before trusting the local mirror: consent
    // withdrawn or granted from another device (or the web app) since the
    // last run must not wait a full poll interval to take effect here.
    const fresh = await fetchTelemetryConsent({ apiOrigin, deviceToken: config.deviceToken });
    if (fresh !== undefined && fresh !== config.telemetryConsent) {
      config = { ...config, telemetryConsent: fresh };
      saveConfig(config);
    }
  }
  applyTelemetryConsent(config.telemetryConsent === true);

  process.on("uncaughtException", (error) => {
    void telemetryRef.client?.reportCrash(error, `${osType()} ${osRelease()}`);
  });
  process.on("unhandledRejection", (reason) => {
    const error =
      reason instanceof Error ? reason : { message: `Unhandled rejection: ${String(reason)}` };
    void telemetryRef.client?.reportCrash(error, `${osType()} ${osRelease()}`);
  });
  bridge.on("status", (event) => {
    if (event.status === "running") void telemetryRef.client?.reportEvent("bridge_connected");
  });

  const consentPoll =
    config.deviceToken !== undefined
      ? startConsentPolling({
          apiOrigin,
          deviceToken: config.deviceToken,
          intervalMs: CONSENT_POLL_INTERVAL_MS,
          initialKnown: config.telemetryConsent === true,
          onChange: (granted) => {
            log({ evt: "bridge.telemetry_consent_changed", granted });
            config = { ...config, telemetryConsent: granted };
            saveConfig(config);
            applyTelemetryConsent(granted);
          },
        })
      : undefined;

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log({ evt: "bridge.shutdown", signal });
    consentPoll?.stop();
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

/** `wss://api.example.com/bridge/relay` -> `https://api.example.com`. */
function relayUrlToApiOrigin(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.origin;
}

main().catch((error: unknown) => {
  log({ evt: "bridge.fatal", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
