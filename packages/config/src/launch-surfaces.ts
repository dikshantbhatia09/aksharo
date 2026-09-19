/**
 * Canonical product launch-surface matrix for Aksharo.
 *
 * Consolidates server-enforced availability across web, desktop, plugins,
 * checkout, affiliates, partner catalogue, and public shares (RLS-006).
 *
 * In accordance with launch-readiness decisions (P0-12, D59), the current
 * release is a web-only beta. Surfaces whose binaries, packages, or provider
 * integrations are absent from this Git HEAD or incomplete default to `false`
 * (fail-closed in production).
 *
 * Setting a key in `FEATURE_FLAGS_JSON` overrides the default:
 * e.g. `{"desktop.download": true}` or `{"web.enabled": false}`.
 */

export const LAUNCH_SURFACE_FLAGS = {
  /** Core web application workspace, editor, and marketing surfaces. */
  web: "web.enabled",
  /** Desktop app download and distribution builds. `apps/desktop` is absent. */
  desktop: "desktop.download",
  /** Premiere / After Effects / Resolve panels. `plugins/` is absent. */
  plugins: "plugins.enabled",
  /** On-device transcription and render through the bundled engine. */
  localMode: "local_mode",
  /** Checkout, subscriptions, pass purchases. Razorpay retry is unimplemented. */
  checkout: "billing.checkout",
  /** Affiliate programme, `/r/<code>` referral landing, attribution. */
  affiliates: "affiliates.enabled",
  /** Partner music/SFX catalogues. Per-track licence snapshots are unwritten. */
  partnerCatalogue: "assets.partnerCatalogue",
  /** Public review links (`/share/:token` and `/s/:token`). */
  publicShares: "shares.public",
} as const;

export type LaunchSurface = keyof typeof LAUNCH_SURFACE_FLAGS;

export type LaunchSurfaceFlagKey = (typeof LAUNCH_SURFACE_FLAGS)[LaunchSurface];

/**
 * Default availability state for each surface.
 *
 * Fail-closed rule: `web` is the single active baseline surface for this release.
 * Every other surface defaults strictly to `false`.
 */
export const DEFAULT_SURFACE_AVAILABILITY: Readonly<Record<LaunchSurface, boolean>> = {
  web: true,
  desktop: false,
  plugins: false,
  localMode: false,
  checkout: false,
  affiliates: false,
  partnerCatalogue: false,
  publicShares: false,
};

export const ALL_LAUNCH_SURFACES = Object.keys(LAUNCH_SURFACE_FLAGS) as readonly LaunchSurface[];

/**
 * Is this surface enabled under the given feature flags?
 *
 * Fail-closed in production:
 * - If flags is null/undefined or an empty record, defaults apply.
 * - An explicit boolean value in flags (`true` or `false`) strictly overrides the default.
 * - An absent non-web surface flag evaluates to `false`.
 */
export function surfaceEnabled(
  surface: LaunchSurface,
  flags?: Readonly<Record<string, unknown>> | null,
): boolean {
  if (flags === null || flags === undefined || typeof flags !== "object") {
    // eslint-disable-next-line security/detect-object-injection -- enumerated key
    return DEFAULT_SURFACE_AVAILABILITY[surface];
  }
  // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal enumerated key
  const flagKey = LAUNCH_SURFACE_FLAGS[surface];
  // eslint-disable-next-line security/detect-object-injection -- bracket access on internal string key
  const value = flags[flagKey];
  if (typeof value === "boolean") {
    return value;
  }
  // eslint-disable-next-line security/detect-object-injection -- enumerated key
  return DEFAULT_SURFACE_AVAILABILITY[surface];
}
