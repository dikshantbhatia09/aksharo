import { HttpStatus, Injectable, Logger } from "@nestjs/common";

import {
  ENTITLEMENT_CACHE_TTL_SEC,
  WORKSPACE_ERRORS,
  workspacesRedisKeys,
} from "./workspaces.constants.js";
import { AppException, PrismaService, RedisService } from "../common/index.js";

import type { $Enums } from "@prisma/client";

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

  /** B02 replaces this body; the signature and the shape are the contract. */
  private async compute(workspaceId: string): Promise<EntitlementView> {
    const [workspace, plan, seatsUsed] = await Promise.all([
      this.prisma.workspace.findFirst({
        where: { id: workspaceId, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.plan.findUnique({
        where: { key: "free" },
        select: { key: true, name: true, creditsPerMonthTenths: true, entitlements: true },
      }),
      this.prisma.membership.count({ where: { workspaceId, status: "active" } }),
    ]);

    if (workspace === null) {
      throw new AppException(WORKSPACE_ERRORS.notFound, "No such workspace.", HttpStatus.NOT_FOUND);
    }
    if (plan === null) {
      // The seed creates the five plans of 04 §Plans; a database without them is
      // misconfigured, not a request the caller can fix.
      throw new AppException(
        "workspace/plans_missing",
        "Plans are not seeded. Run `pnpm --filter @montaj/api db:seed`.",
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const entitlements = (plan.entitlements ?? {}) as Record<string, unknown>;
    const seatsIncluded =
      typeof entitlements["seatsIncluded"] === "number" ? entitlements["seatsIncluded"] : 0;

    return {
      workspaceId,
      planKey: plan.key,
      planName: plan.name,
      creditsPerMonthTenths: plan.creditsPerMonthTenths,
      seatsIncluded,
      seatsUsed,
      entitlements,
      computedAt: new Date().toISOString(),
    };
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
