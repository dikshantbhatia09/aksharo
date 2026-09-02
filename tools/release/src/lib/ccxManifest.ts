import { PLUGIN_IDS } from "@montaj/config/brand";

export interface UxpManifest {
  id: string;
  name: string;
  version: string;
  host?: { app: string; minVersion: string }[];
  [key: string]: unknown;
}

export interface ManifestValidation {
  valid: boolean;
  errors: string[];
}

const EXPECTED_ID = PLUGIN_IDS.premiereUxp; // "ai.aksharo.panel"
const MIN_VERSION = "25.6";

/**
 * Validates a UXP `manifest.json` against CONTRACTS §0 plugin id and the Premiere UXP
 * minVersion (RR-03: `.ccx` packaging, no signing required). Called by `package-ccx` before
 * zipping so a bad manifest fails the CLI rather than shipping a broken package.
 */
export function validateUxpManifest(manifest: unknown): ManifestValidation {
  const errors: string[] = [];
  if (typeof manifest !== "object" || manifest === null) {
    return { valid: false, errors: ["manifest.json is not a JSON object"] };
  }
  const m = manifest as Partial<UxpManifest>;

  if (m.id !== EXPECTED_ID) {
    errors.push(`manifest.id must be "${EXPECTED_ID}" (CONTRACTS §0), got ${JSON.stringify(m.id)}`);
  }
  if (!m.name || typeof m.name !== "string") {
    errors.push("manifest.name is required");
  }
  if (!m.version || typeof m.version !== "string" || !/^\d+\.\d+\.\d+/.test(m.version)) {
    errors.push("manifest.version must be a semver string");
  }
  if (!Array.isArray(m.host) || m.host.length === 0) {
    errors.push("manifest.host must list at least one host app");
  } else {
    const premiere = m.host.find((h) => h.app === "PPRO");
    if (!premiere) {
      errors.push('manifest.host must include an entry with app "PPRO" (Premiere Pro)');
    } else if (compareVersions(premiere.minVersion, MIN_VERSION) < 0) {
      errors.push(`manifest.host[PPRO].minVersion must be >= ${MIN_VERSION}, got ${premiere.minVersion}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
