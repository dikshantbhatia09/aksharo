import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { aksharoDir } from "@montaj/bridge-core";

/**
 * `apps/bridge`'s own config file (brief §5): `~/.aksharo/config.json`, separate
 * from the discovery file (which is regenerated every run and never hand-edited).
 * Holds the device token and the autostart toggle; `bridge-core` knows nothing
 * about either.
 */

export interface BridgeAppConfig {
  /** The current bridge access token (`kind:"bridge"`), minted by `POST /devices/{id}/bridge-token`. */
  deviceToken?: string;
  relayUrl?: string;
  autostart?: boolean;
  /** The api origin `device-auth.ts` talks to (B08b's device-code + registration bootstrap). */
  apiOrigin?: string;
  /** The B08 device row this install registered, set once on first run. */
  deviceId?: string;
  /**
   * The refresh token from the device-code sign-in that registered this
   * device (`kind:"desktop"`) — used to re-mint `deviceToken` without the
   * pairing screen again once it expires, until it itself is revoked.
   */
  sessionRefreshToken?: string;
  /** Epoch ms `deviceToken` expires at (CONTRACTS §5: 15 minutes from mint). */
  deviceTokenExpiresAt?: number;
  /**
   * C12: local mirror of the `telemetry` consent, same reasoning as the
   * desktop shell's `telemetry/consent-store.ts` — off until the server row
   * says otherwise. Synced from `GET /consents` on startup and refreshed on
   * a poll (M04, `consent-sync.ts`; `main.ts` persists whatever the server
   * last answered here).
   */
  telemetryConsent?: boolean;
}

function configPath(): string {
  return join(aksharoDir(), "config.json");
}

export function loadConfig(): BridgeAppConfig {
  const path = configPath();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (!existsSync(path)) return {};
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    return JSON.parse(readFileSync(path, "utf8")) as BridgeAppConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: BridgeAppConfig): void {
  const dir = aksharoDir();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
