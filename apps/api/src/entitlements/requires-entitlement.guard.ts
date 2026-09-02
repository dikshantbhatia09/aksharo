import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { CreditOperation } from "@montaj/config";

import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { EntitlementService } from "../workspaces/entitlement.service.js";

import type { AuthenticatedRequest } from "../common/guards/index.js";
import type { EntitlementView } from "../workspaces/entitlement.service.js";

export const ENTITLEMENT_CHECK_KEY = "montaj:entitlement_check";

/**
 * The three named checks the brief calls out (Free blocked, Creator allowed),
 * plus any `@montaj/config` operation key — gated straight off
 * `entitlements.operations[operation]`, which `prisma/seed-data.ts`'s
 * `operationsFor()` derives from the SAME `BURN_RATES[operation].minimumPlan`
 * `quote()` uses, so a producer's burn rate and its entitlement gate cannot
 * drift apart. A predicate is escape hatch for a check this list does not name.
 */
export type EntitlementCheck =
  | "translation"
  | "audioClean"
  | "export4k"
  | CreditOperation
  | ((view: EntitlementView) => boolean);

/**
 * `@RequiresEntitlement("translation")` — blocks the route unless the caller's
 * workspace entitlement satisfies the named check (04 §Entitlement enforcement).
 *
 * Applied to a route already wearing `WorkspaceMemberGuard` (so `request.
 * principal.workspaceId` is trustworthy) and {@link RequiresEntitlementGuard}.
 * A11/A21/A22/B04 apply this to their own producer routes once they exist; this
 * WP ships the guard and its tests, not a retrofit onto routes nobody has
 * written yet.
 */
export const RequiresEntitlement = (check: EntitlementCheck): MethodDecorator & ClassDecorator =>
  SetMetadata(ENTITLEMENT_CHECK_KEY, check);

/**
 * Reads the computed entitlement (60 s Redis cache, `EntitlementService`) and
 * rejects with `entitlement/upgrade_required` (403) when the named check fails.
 *
 * Always runs after `WorkspaceMemberGuard`: the workspace id comes from the path
 * parameter named `id` (the same convention that guard reads), falling back to
 * the token's `ws` claim for a route with no `:id` segment.
 */
@Injectable()
export class RequiresEntitlementGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly entitlements: EntitlementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const check = this.reflector.getAllAndOverride<EntitlementCheck | undefined>(
      ENTITLEMENT_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (check === undefined) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;
    if (principal === undefined) {
      throw new AppException(
        ERROR_CODES.unauthorized,
        "Authentication is required.",
        HttpStatus.UNAUTHORIZED,
      );
    }

    const pathWorkspaceId = (request.params as Record<string, string | undefined>)["id"];
    const workspaceId = pathWorkspaceId ?? principal.workspaceId;
    const view = await this.entitlements.forWorkspace(workspaceId);

    if (satisfiesCheck(view, check)) return true;

    throw new AppException(
      ERROR_CODES.entitlementUpgradeRequired,
      `Your ${view.planName} plan does not include ${describeCheck(check)}.`,
      HttpStatus.FORBIDDEN,
      { planKey: view.planKey, check: describeCheck(check) },
    );
  }
}

function satisfiesCheck(view: EntitlementView, check: EntitlementCheck): boolean {
  if (typeof check === "function") return check(view);

  const entitlements = view.entitlements;
  switch (check) {
    case "translation":
      return entitlements["translation"] !== undefined && entitlements["translation"] !== "none";
    case "audioClean":
      return entitlements["audioClean"] === true;
    case "export4k":
      return entitlements["maxExportResolution"] === "4k";
    default: {
      const operations = entitlements["operations"] as Record<string, unknown> | undefined;
      return operations?.[check] === true;
    }
  }
}

function describeCheck(check: EntitlementCheck): string {
  return typeof check === "function" ? "this feature" : check;
}
