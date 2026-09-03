/**
 * Client-side licence re-check for sfx/music items (D09 brief §Scope 1/2, D43 "cloud render
 * only"): both plugins re-check `allowsRawFileDelivery` and `licenceSnapshot.surface` before
 * ever placing a downloaded asset on a panel-controlled track, even though the API already
 * enforces the same predicate server-side (`apps/api/src/audio-assets/asset-allowed.ts`, D04a) —
 * a stale cached item (re-sync not yet run) must never place a partner asset locally just
 * because the panel's own copy of the item still says `accepted`.
 *
 * This is deliberately a much smaller check than the API's full `assetAllowed` predicate (no
 * territory/plan/term gates — those already happened before the item reached `accepted`, and
 * this package has no workspace/territory context to re-evaluate them with). It exists only to
 * enforce the one rule the brief calls out by name.
 */
import type { LicenceDenyReason, LicenceSnapshot } from "./types.js";

export const PANEL_SURFACE = "panel";

export interface LicenceCheckResult {
  readonly allowed: boolean;
  readonly reasons: readonly LicenceDenyReason[];
}

/** The D43 message shown when a partner-catalogue asset is refused on an NLE surface. */
export const CLOUD_RENDER_ONLY_MESSAGE =
  "This track is a partner-catalogue asset and can only be used in a cloud render, not placed " +
  "directly on the timeline. Accept it as-is and export via cloud render, or swap it for an " +
  "owned-library asset.";

export function checkLicenceForPanel(snapshot: LicenceSnapshot): LicenceCheckResult {
  const reasons: LicenceDenyReason[] = [];
  if (!snapshot.allowsRawFileDelivery) {
    reasons.push("not-owned");
  }
  if (!snapshot.surface.includes(PANEL_SURFACE)) {
    reasons.push("surface-not-allowed");
  }
  return { allowed: reasons.length === 0, reasons };
}
