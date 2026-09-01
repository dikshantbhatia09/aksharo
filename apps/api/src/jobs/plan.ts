import type { PlanKey, PrismaClient } from "@prisma/client";

/**
 * Which plan a workspace is on, for admission control.
 *
 * A subscription in a live state wins; anything else (no subscription, expired,
 * cancelled) falls back to `free`, which is the *smallest* set of limits — a
 * lookup failure must never widen a cap. B02's entitlements engine replaces this
 * with the full `Entitlement` computation (plan + seats + passes + flags); until
 * then the plan key is all admission control needs.
 *
 * Written as a free function rather than a provider so both the jobs module and
 * the no-op `CreditsFacade` can use it without either module importing the other.
 */

/** Subscription states that still entitle a workspace to its plan's limits. */
const LIVE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "paused"] as const;

/** The subset of the Prisma client this needs, so tests can pass a stub. */
export interface PlanLookupClient {
  readonly subscription: {
    findFirst: PrismaClient["subscription"]["findFirst"];
  };
}

export async function resolveWorkspacePlan(
  prisma: PlanLookupClient,
  workspaceId: string,
): Promise<PlanKey> {
  const subscription = await prisma.subscription.findFirst({
    where: { workspaceId, status: { in: [...LIVE_SUBSCRIPTION_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { plan: { select: { key: true } } },
  });
  return subscription?.plan.key ?? "free";
}
