import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import {
  ENTITLEMENT_CACHE_TTL_SEC,
  WORKSPACE_ERRORS,
  workspacesRedisKeys,
} from "./workspaces.constants.js";
import { AppException, PrismaService, RedisService } from "../common/index.js";
import { PLAN_KEYS } from "../jobs/jobs.config.js";
import { resolveWorkspacePlan } from "../jobs/plan.js";

import type { $Enums } from "@prisma/client";

/** Ladder position, so "at least Starter" is a numeric comparison. */
const PLAN_RANK = new Map<$Enums.PlanKey, number>(PLAN_KEYS.map((key, index) => [key, index]));

function atLeast(plan: $Enums.PlanKey, floor: $Enums.PlanKey): $Enums.PlanKey {
  return (PLAN_RANK.get(plan) ?? 0) >= (PLAN_RANK.get(floor) ?? 0) ? plan : floor;
}

export interface EntitlementView {
  readonly workspaceId: string;
  readonly planKey: $Enums.PlanKey;
  readonly planName: string;
  readonly creditsPerMonthTenths: number;
  readonly seatsIncluded: number;
  readonly seatsUsed: number;
  readonly entitlements: Record<string, unknown>;
  readonly computedAt: string;
}

/**
 * `GET /workspaces/{id}/entitlement` — what this workspace may do (07 §Workspaces).
 *
 * **A stub, on purpose.** It returns the seeded **Free** plan's entitlements for
 * every workspace. The real computation is B02's and is not a lookup: a plan, plus
 * the seats a subscription pays for, plus any purchased passes, plus feature
 * flags, plus the grace window a failed renewal opens. Guessing at that now would
 * produce a second, wrong implementation for B02 to delete.
 *
 * What is **not** a stub is the shape and the cache. Clients render against this
 * document and 07 pins the 60-second cache, so both are settled here, and B02
 * changes the body of `compute()` and nothing else.
 *
 * The cache is keyed on the workspace and lives in Redis rather than in process,
 * because two API instances must not disagree about what a workspace may do. A
 * Redis outage degrades to computing every time, never to failing.
 */
@Injectable()
export class EntitlementService {
  private readonly logger = new Logger(EntitlementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async forWorkspace(workspaceId: string): Promise<EntitlementView> {
    const key = workspacesRedisKeys.entitlement(workspaceId);

    const cached = await this.read(key);
    if (cached !== null) return cached;

    const computed = await this.compute(workspaceId);
    await this.write(key, computed);
    return computed;
  }

  /** Drop the cached snapshot; called when a membership or a plan changes. */
  async invalidate(workspaceId: string): Promise<void> {
    try {
      await this.redis.client.del(workspacesRedisKeys.entitlement(workspaceId));
    } catch (error) {
      this.logger.warn({ err: error, workspaceId }, "could not invalidate the entitlement cache");
    }
  }

  /**
   * plan + seats + active passes + flags (04 §Entitlement enforcement, D32).
   *
   * **Plan.** `resolveWorkspacePlan` (the same lookup `AdmissionService` and the
   * no-op `CreditsFacade` used in Wave 1) reads the live subscription; no
   * subscription falls back to `free`, the smallest set of limits.
   *
   * **Active passes.** `passes_purchased` rows with `kind = "week_pass"` and
   * `endsAt` in the future raise the *effective* plan to at least Starter (04
   * §Offers: "7 days of Starter"), never lower it — a pass tops a workspace up,
   * it never downgrades one. `pay_once` purchases are not read here: 04 sells
   * them as 30-day subscriptions at the monthly price, so they already show up
   * as a `subscriptions` row with `interval: "once"` and need no separate path.
   *
   * **Flags.** `feature_flags` rows this workspace is targeted for (by id or by
   * plan key) or that are enabled with no target restriction at all. Percentage
   * rollout (`rolloutPct`) is intentionally not evaluated here — this WP has no
   * specified bucketing hash, and a flag with a nonzero rollout and no explicit
   * target simply reads `false` until B06/the flag's own owner adds one.
   *
   * The returned `entitlements` is the plan's seeded JSON (`prisma/seed-data.ts`
   * — `watermark`, `maxExportResolution`, `maxFileBytes`, `maxDurationMs`,
   * `translation`, `audioClean`, `passes`, `plugins`, `activeDevices`,
   * `seatsIncluded`, `retentionDays`, `queuePriority`, `apiAccess`,
   * `operations` — already the shape the brief names, field-for-field) plus
   * `flags`. Nothing here recomputes those numbers: `operationsFor()` already
   * ties `operations` to `@montaj/config`'s `BURN_RATES[operation].minimumPlan`,
   * the same table `quote()` reads, so a producer's burn rate and this gate can
   * never disagree.
   */
  private async compute(workspaceId: string): Promise<EntitlementView> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: { id: true },
    });
    if (workspace === null) {
      throw new AppException(WORKSPACE_ERRORS.notFound, "No such workspace.", HttpStatus.NOT_FOUND);
    }

    const [subscriptionPlan, seatsUsed, activeWeekPass, liveSubscription] = await Promise.all([
      resolveWorkspacePlan(this.prisma, workspaceId),
      this.prisma.membership.count({ where: { workspaceId, status: "active" } }),
      this.prisma.passPurchase.findFirst({
        where: { workspaceId, kind: "week_pass", endsAt: { gt: new Date() } },
        select: { id: true },
      }),
      this.prisma.subscription.findFirst({
        where: { workspaceId, status: { in: ["trialing", "active", "past_due", "paused"] } },
        orderBy: { createdAt: "desc" },
        select: { seats: true },
      }),
    ]);
    const effectivePlanKey =
      activeWeekPass === null ? subscriptionPlan : atLeast(subscriptionPlan, "starter");

    const plan = await this.prisma.plan.findUnique({
      where: { key: effectivePlanKey },
      select: { key: true, name: true, creditsPerMonthTenths: true, entitlements: true },
    });
    if (plan === null) {
      // The seed creates the five plans of 04 §Plans; a database without them is
      // misconfigured, not a request the caller can fix.
      throw new AppException(
        "workspace/plans_missing",
        "Plans are not seeded. Run `pnpm --filter @montaj/api db:seed`.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const planEntitlements = (plan.entitlements ?? {}) as Record<string, unknown>;
    const seatsIncluded =
      typeof planEntitlements["seatsIncluded"] === "number" ? planEntitlements["seatsIncluded"] : 0;

    // Agency pools credits and device slots per seat (04 §Plans, B08): a plan
    // marked `perSeat` in its seeded entitlements multiplies both the monthly
    // grant and the device ceiling by the seats the live subscription actually
    // bills for (never by `seatsUsed`, which is memberships, not what the
    // workspace pays for -- an unfilled paid seat still pools its credits and
    // still opens a device slot). No live subscription (a team not yet
    // checked out, or Free/Starter/Creator, none of which carry `seatPrice`)
    // means exactly one seat's worth.
    const perSeat = planEntitlements["perSeat"] === true;
    const billedSeats = Math.max(1, liveSubscription?.seats ?? 1);
    const creditsPerMonthTenths = perSeat
      ? plan.creditsPerMonthTenths * billedSeats
      : plan.creditsPerMonthTenths;
    const activeDevices =
      perSeat && typeof planEntitlements["activeDevices"] === "number"
        ? planEntitlements["activeDevices"] * billedSeats
        : planEntitlements["activeDevices"];

    return {
      workspaceId,
      planKey: plan.key,
      planName: plan.name,
      creditsPerMonthTenths,
      seatsIncluded,
      seatsUsed,
      entitlements: {
        ...planEntitlements,
        activeDevices,
        billedSeats,
        flags: await this.activeFlags(workspaceId, plan.key),
      },
      computedAt: new Date().toISOString(),
    };
  }

  /** Feature flags enabled for this workspace, by id or by plan key (07). */
  private async activeFlags(
    workspaceId: string,
    planKey: $Enums.PlanKey,
  ): Promise<Record<string, boolean>> {
    const flags = await this.prisma.featureFlag.findMany({
      select: { key: true, enabled: true, targets: true },
    });
    const result: Record<string, boolean> = {};
    for (const flag of flags) {
      result[flag.key] = flag.enabled && this.flagTargets(flag.targets, workspaceId, planKey);
    }
    return result;
  }

  /** `true` when `targets` is empty (no restriction) or names this workspace/plan. */
  private flagTargets(targets: unknown, workspaceId: string, planKey: $Enums.PlanKey): boolean {
    if (typeof targets !== "object" || targets === null) return true;
    const t = targets as { workspaceIds?: unknown; planKeys?: unknown };
    const workspaceIds = Array.isArray(t.workspaceIds) ? t.workspaceIds : [];
    const planKeys = Array.isArray(t.planKeys) ? t.planKeys : [];
    if (workspaceIds.length === 0 && planKeys.length === 0) return true;
    return workspaceIds.includes(workspaceId) || planKeys.includes(planKey);
  }

  private async read(key: string): Promise<EntitlementView | null> {
    try {
      const raw = await this.redis.client.get(key);
      return raw === null ? null : (JSON.parse(raw) as EntitlementView);
    } catch (error) {
      this.logger.warn({ err: error }, "entitlement cache unavailable; computing");
      return null;
    }
  }

  private async write(key: string, value: EntitlementView): Promise<void> {
    try {
      await this.redis.client.set(key, JSON.stringify(value), "EX", ENTITLEMENT_CACHE_TTL_SEC);
    } catch (error) {
      this.logger.warn({ err: error }, "could not cache the entitlement");
    }
  }
}
