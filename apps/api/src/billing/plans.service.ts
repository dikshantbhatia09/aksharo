import { HttpStatus, Injectable } from "@nestjs/common";

import { BILLING_ERRORS } from "./billing.constants.js";
import { hasHalfyearPrice, parsePlanPrices, parseSeatPrice, type PlanForPricing } from "./money.js";
import { AppException, PrismaService } from "../common/index.js";

import type { $Enums, Plan } from "@prisma/client";

export interface PlanView {
  readonly key: $Enums.PlanKey;
  readonly name: string;
  readonly prices: Record<string, Record<string, number>>;
  readonly creditsPerMonthTenths: number;
  readonly seatPrice: Record<string, number> | null;
  readonly hasHalfyear: { readonly INR: boolean; readonly USD: boolean };
}

/** `GET /billing/plans` (public) and the plan lookups every other billing service needs. */
@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  /** The public catalogue, INR and USD, active plans only. */
  async list(): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      where: { active: true },
      orderBy: { version: "asc" },
    });
    return plans.map(toPlanView);
  }

  /** Look up an active plan by key, or throw `billing/plan_not_found`. */
  async require(planKey: $Enums.PlanKey): Promise<Plan> {
    const plan = await this.prisma.plan.findUnique({ where: { key: planKey } });
    if (plan === null) {
      throw new AppException(
        BILLING_ERRORS.planNotFound,
        `No such plan "${planKey}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    if (!plan.active) {
      throw new AppException(
        BILLING_ERRORS.planInactive,
        `Plan "${planKey}" is no longer sold.`,
        HttpStatus.CONFLICT,
      );
    }
    return plan;
  }
}

export function toPricingPlan(plan: Plan): PlanForPricing {
  return {
    key: plan.key,
    active: plan.active,
    prices: plan.prices,
    seatPrice: plan.seatPrice,
    entitlements: plan.entitlements,
  };
}

function toPlanView(plan: Plan): PlanView {
  const prices = parsePlanPrices(plan.prices);
  const seatPrice = parseSeatPrice(plan.seatPrice);
  return {
    key: plan.key,
    name: plan.name,
    prices,
    creditsPerMonthTenths: plan.creditsPerMonthTenths,
    seatPrice,
    hasHalfyear: {
      INR: hasHalfyearPrice(toPricingPlan(plan), "INR"),
      USD: hasHalfyearPrice(toPricingPlan(plan), "USD"),
    },
  };
}
