import type { PlanTier } from "./credits.js";

/**
 * Cross-cutting, plan-gated feature flags shared by the API's entitlement
 * seed data (`apps/api/prisma/seed-data.ts`, the source of truth for the
 * actual per-workspace value) and any client that needs the same gate
 * without a round trip — the desktop shell in particular, which must decide
 * whether to enable local mode (brief C04 §4) before it has necessarily
 * reached the network at all.
 *
 * This file is deliberately a static ladder, not a live entitlement: it
 * answers "does this plan tier ever get local mode" for a fast, offline-safe
 * check (e.g. greying the desktop's "New local project" affordance before a
 * cached entitlement view is available). The authoritative, per-workspace
 * answer — accounting for trials, grandfathering, admin overrides — still
 * comes from the API's `EntitlementService` (`apps/api/src/workspaces/
 * entitlement.service.ts`) whenever the caller can reach it.
 */

/** Plan ladder order, lowest first — matches `docs/CONTRACTS.md`'s plan tiers. */
const PLAN_ORDER: readonly PlanTier[] = ["free", "starter", "creator", "studio", "agency"];

function planRank(plan: PlanTier): number {
  return PLAN_ORDER.indexOf(plan);
}

/** Lowest plan tier local mode ships on (brief C04: "Starter and above"). */
export const LOCAL_MODE_MIN_PLAN: PlanTier = "starter";

/** True if `plan` is at or above `minimum` on the plan ladder. */
export function planAtLeast(plan: PlanTier, minimum: PlanTier): boolean {
  return planRank(plan) >= planRank(minimum);
}

/** Whether a workspace on `plan` may use local mode at all (brief C04 §4). */
export function hasLocalMode(plan: PlanTier): boolean {
  return planAtLeast(plan, LOCAL_MODE_MIN_PLAN);
}
