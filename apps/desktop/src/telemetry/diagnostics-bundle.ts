import { redactConfig, tailAndRedact } from "@montaj/bridge-core";

import { buildZip, type ZipEntry } from "./zip-writer.js";

/**
 * Everything the diagnostics-bundle builder needs, gathered by the caller
 * (`main/index.ts`) so this module stays pure: it never touches `fs` or
 * `electron` itself, matching every other file in this directory.
 */
export interface DiagnosticsBundleInput {
  readonly appVersion: string;
  readonly platform: string;
  readonly osVersion: string;
  readonly updateChannel: string;
  /** Recent log lines, oldest first — from disk, the ring buffer, or both. */
  readonly logLines: readonly string[];
  /** The renderer/app's own non-secret settings, e.g. locale, feature flags. */
  readonly config: Record<string, unknown>;
  /**
   * The bridge discovery file's contents (`bridge-core`'s `discoveryFilePath`),
   * when the local bridge is running — brief §3: "bridge discovery file minus
   * the bearer".
   */
  readonly bridgeDiscovery?: Record<string, unknown>;
}

const LOG_LINES_LIMIT = 500;

/**
 * Builds the diagnostics-bundle zip (brief §2/§3): logs redacted, config
 * without secrets, versions, and the bridge discovery file with `bearer`
 * stripped rather than merely redacted-in-place — a discovery file's bearer
 * is a live loopback credential, not just log noise, so it is dropped
 * entirely rather than replaced with a `[redacted:*]` marker that could be
 * mistaken for a real (if masked) value.
 */
export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): Buffer {
  const versions = {
    appVersion: input.appVersion,
    platform: input.platform,
    osVersion: input.osVersion,
    updateChannel: input.updateChannel,
    builtAt: new Date().toISOString(),
  };

  const logs = tailAndRedact(input.logLines, LOG_LINES_LIMIT).join("\n");
  const config = redactConfig(input.config);

  const entries: ZipEntry[] = [
    { name: "versions.json", data: Buffer.from(JSON.stringify(versions, null, 2), "utf8") },
    { name: "logs.txt", data: Buffer.from(logs, "utf8") },
    { name: "config.json", data: Buffer.from(JSON.stringify(config, null, 2), "utf8") },
  ];

  if (input.bridgeDiscovery !== undefined) {
    const { bearer: _bearer, ...withoutBearer } = input.bridgeDiscovery;
    entries.push({
      name: "bridge-discovery.json",
      data: Buffer.from(JSON.stringify(withoutBearer, null, 2), "utf8"),
    });
  }

  return buildZip(entries);
}
