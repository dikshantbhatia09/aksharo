/**
 * `/plugins/manifest` consumption (D65: "`/plugins/manifest` publishes min/max API per
 * host"). Identical logic to `plugins/premiere-uxp/src/version/manifestCheck.ts` — kept as
 * this package's own copy rather than a `plugins/shared-ui` extraction (see
 * `plugins/resolve-panel/README.md` "Shared UI" for why this WP did not create that
 * package). Pure logic only; the actual HTTP call is made by whatever wires this panel to
 * the API and passed in as `PluginManifestEntry`.
 */

export interface PluginManifestEntry {
  readonly minVersion: string;
  readonly maxVersion: string;
  readonly latestVersion: string;
  readonly updateUrl?: string;
}

export interface UpdateBannerState {
  readonly show: boolean;
  readonly severity: "none" | "update-available" | "unsupported";
  readonly latestVersion?: string;
  readonly updateUrl?: string;
}

/** Simple dotted-integer semver compare; returns <0, 0, >0. Good enough for "1.2.3". */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function evaluateUpdateBanner(
  currentVersion: string,
  manifest: PluginManifestEntry,
): UpdateBannerState {
  if (compareSemver(currentVersion, manifest.minVersion) < 0) {
    return {
      show: true,
      severity: "unsupported",
      latestVersion: manifest.latestVersion,
      updateUrl: manifest.updateUrl,
    };
  }
  if (compareSemver(currentVersion, manifest.latestVersion) < 0) {
    return {
      show: true,
      severity: "update-available",
      latestVersion: manifest.latestVersion,
      updateUrl: manifest.updateUrl,
    };
  }
  return { show: false, severity: "none" };
}
