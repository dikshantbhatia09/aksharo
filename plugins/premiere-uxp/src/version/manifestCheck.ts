/**
 * `/plugins/manifest` consumption (D65: "`/plugins/manifest` publishes min/max API per host").
 * The exact response shape isn't in `docs/CONTRACTS.md` yet (that endpoint's contract belongs
 * to the API work package that serves it, not C05a) — this module assumes the shape below,
 * documented here so the API side can match it or this file gets a one-line adjustment:
 *
 *   GET /plugins/manifest -> {
 *     premiereUxp: { minVersion, maxVersion, latestVersion, updateUrl? }
 *   }
 *
 * Pure logic only; the actual HTTP call is made by whatever wires this panel to the API
 * (`src/index.tsx` in production, a mock in tests) and passed in as `PluginManifestEntry`.
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

/**
 * `currentVersion` below `minVersion` -> "unsupported" (the panel should stop and tell the
 * user to update, since the bridge/API may refuse it outright). Between min and latest ->
 * "update-available" (non-blocking banner). At or above latest -> no banner.
 */
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
