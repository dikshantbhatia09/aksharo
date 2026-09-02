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
  deviceToken?: string;
  relayUrl?: string;
  autostart?: boolean;
}

function configPath(): string {
  return join(aksharoDir(), "config.json");
}

export function loadConfig(): BridgeAppConfig {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BridgeAppConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: BridgeAppConfig): void {
  const dir = aksharoDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
