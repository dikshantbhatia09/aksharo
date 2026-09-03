import type { AssetSurface, AudioAsset } from "@prisma/client";

/**
 * The one licence predicate every retrieval path calls (D04a; 09-ai-pipeline
 * §6, 12-redesign-decisions D43/D44): licence predicates are evaluated
 * *before* CLAP similarity, energy or mood ranking, never after — an asset
 * that fails any gate here must never reach a ranking function, let alone a
 * user.
 *
 * Only the fields `AudioAsset` actually carries are consulted (D44's typed
 * columns): `allowsRawFileDelivery` for the D43 surface split, `territory`
 * for territory, `provider`/`clearanceMethod`/term dates for clearance state,
 * and plan is gated by the caller's plan tier against the Studio-gated
 * library entitlement (`packages/config` `BURN_RATES.sfxMusicPass`).
 */

/** Plan ladder, matching `@montaj/config`'s `PlanTier` (kept as a literal union
 * here so this module needs no build-time dependency on `packages/config`). */
export type PlanTier = "free" | "starter" | "creator" | "studio" | "agency";

const PLAN_ORDER: readonly PlanTier[] = ["free", "starter", "creator", "studio", "agency"];

function planAtLeast(plan: PlanTier, minimum: PlanTier): boolean {
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(minimum);
}

export interface AssetAllowedContext {
  readonly surface: AssetSurface;
  readonly plan: PlanTier;
  readonly territory: string;
  /** Instant to evaluate `termStart`/`termEnd` against; defaults to `Date.now()`. */
  readonly at?: Date;
}

/** The subset of `AudioAsset` the predicate reads — a plain object is enough,
 * so callers (including property tests) never need a full Prisma row. */
export type AssetAllowedInput = Pick<
  AudioAsset,
  "provider" | "territory" | "termStart" | "termEnd" | "allowsRawFileDelivery" | "clearanceMethod"
>;

export type AssetDenyReason =
  | "surface-requires-owned"
  | "territory-not-covered"
  | "plan-below-minimum"
  | "clearance-not-established"
  | "term-not-started"
  | "term-expired";

export interface AssetAllowedResult {
  readonly allowed: boolean;
  /** Every gate the asset failed, in evaluation order; empty when allowed. */
  readonly reasons: readonly AssetDenyReason[];
}

/**
 * D43: only wholly-owned assets (`allowsRawFileDelivery`) may ever reach the
 * panel, desktop or offline (api) surfaces — a partner-catalogue asset is
 * `cloud_render`-only regardless of every other gate. The Passes tab reads
 * `allowed === false` with `"surface-requires-owned"` in `reasons` to render
 * the D43 "cloud render only" badge instead of hiding the item outright.
 */
export function assetAllowed(
  asset: AssetAllowedInput,
  context: AssetAllowedContext,
): AssetAllowedResult {
  const reasons: AssetDenyReason[] = [];
  const at = context.at ?? new Date();

  if (context.surface !== "cloud_render" && !asset.allowsRawFileDelivery) {
    reasons.push("surface-requires-owned");
  }

  const territoryOk =
    asset.territory.includes("WORLD") || asset.territory.includes(context.territory);
  if (!territoryOk) {
    reasons.push("territory-not-covered");
  }

  // Library fee is plan-gated, not per-credit (D44) — a partner-catalogue
  // asset additionally requires the plan that carries the entitlement.
  if (asset.provider !== "owned" && !planAtLeast(context.plan, "studio")) {
    reasons.push("plan-below-minimum");
  }

  // A partner asset with no established clearance path can never be placed;
  // an owned asset needs none (`clearanceMethod: "none"` is its steady state).
  if (asset.provider !== "owned" && asset.clearanceMethod === "none") {
    reasons.push("clearance-not-established");
  }

  if (asset.termStart !== null && asset.termStart > at) {
    reasons.push("term-not-started");
  }
  if (asset.termEnd !== null && asset.termEnd < at) {
    reasons.push("term-expired");
  }

  return { allowed: reasons.length === 0, reasons };
}
