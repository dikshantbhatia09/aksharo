/**
 * Which product surfaces this release actually ships.
 *
 * One place, because the launch-readiness audit found the answer scattered and
 * inconsistent: the marketing nav offered Plugins and Download, the studio
 * sidebar offered "Get the desktop app", and the pricing page described paid
 * plans — while `apps/desktop`, `apps/bridge`, `apps/engine`, `plugins/` and
 * `tools/release` are **not in this Git HEAD at all** (`git ls-tree HEAD apps/`
 * lists api, model-server, render, web, worker-ai and worker-media, and nothing
 * else), and the Razorpay renewal-retry path still throws "not implemented"
 * (launch-readiness P0-12).
 *
 * A customer who clicks one of those reaches a page describing something they
 * cannot have. That is not a cosmetic problem: it is the product telling them
 * something untrue, on the first visit, in writing.
 *
 * Everything here defaults to `false`. A surface becomes visible in the same
 * change that makes it real — restoring the source, repairing its CI, signing
 * its artefacts — and not before. To turn one on for an environment that does
 * have it, set the matching key in `FEATURE_FLAGS_JSON` rather than editing
 * this default: `{"desktop.download": true}`.
 */

export const LAUNCH_SURFACE_FLAGS = {
  /** Desktop app download. `apps/desktop` is absent; `release-desktop.yml` builds nothing. */
  desktop: "desktop.download",
  /** Premiere / After Effects / Resolve panels. `plugins/` is absent. */
  plugins: "plugins.enabled",
  /** On-device transcription and render through the bundled engine. */
  localMode: "local_mode",
  /** Checkout, subscriptions, refunds. Razorpay manual renewal retry is unimplemented. */
  checkout: "billing.checkout",
  /** Affiliate programme. RazorpayX fund-account creation is intentionally absent. */
  affiliates: "affiliates.enabled",
  /** Partner music/SFX catalogues. Per-track licence snapshots are still TODO. */
  partnerCatalogue: "assets.partnerCatalogue",
} as const;

export type LaunchSurface = keyof typeof LAUNCH_SURFACE_FLAGS;

/**
 * Is this surface part of the running release?
 *
 * Absent flag means off. A surface that has to be remembered is a surface that
 * ships half-built — the same reasoning that made the breached-password check
 * default on rather than off.
 */
export function surfaceEnabled(
  surface: LaunchSurface,
  flags: Readonly<Record<string, boolean>>,
): boolean {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on an internal enumerated key, not attacker-controlled
  return flags[LAUNCH_SURFACE_FLAGS[surface]] === true;
}
