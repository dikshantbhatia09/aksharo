import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { aksharoDir, generateBearerToken } from "@montaj/bridge-core";
import { EngineDiscoveryFileSchema, type EngineDiscoveryFile } from "@montaj/engine-client";

/**
 * The engine's own discovery file (brief §1: "an ephemeral port written to a
 * discovery file (0600, bearer)"). Separate from the bridge's `bridge.json`
 * (`packages/bridge-core/src/discovery.ts`) because the engine and the bridge
 * are independent sidecars with independent lifetimes (brief: "C02 spawns the
 * sidecar" — the desktop shell, not the bridge) — one discovery file per
 * process keeps a stale bridge restart from ever looking like a stale engine.
 * `aksharoDir()` and `generateBearerToken()` are reused from `bridge-core`
 * verbatim: same directory, same token-generation strength, no reason to
 * reimplement either.
 */

export { generateBearerToken };
export type { EngineDiscoveryFile };

export function engineDiscoveryFilePath(dir = aksharoDir()): string {
  return join(dir, "engine.json");
}

/** Writes the discovery file atomically with `0600` permissions (T22). */
export function writeEngineDiscoveryFile(
  file: EngineDiscoveryFile,
  path = engineDiscoveryFilePath(),
): void {
  const dir = aksharoDir();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${String(process.pid)}`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    renameSync(tmp, path);
  } catch {
    copyFileSync(tmp, path);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    chmodSync(path, 0o600);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    unlinkSync(tmp);
  }
}

export function readEngineDiscoveryFile(
  path = engineDiscoveryFilePath(),
): EngineDiscoveryFile | undefined {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  if (!existsSync(path)) return undefined;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const raw = readFileSync(path, "utf8");
    const parsed = EngineDiscoveryFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function removeEngineDiscoveryFile(path = engineDiscoveryFilePath()): void {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    unlinkSync(path);
  } catch {
    // Already gone — stop() being called twice, or a launch that never wrote one.
  }
}
