import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { type NinePassHypothesisMetrics, OffersMetricsService } from "./offers-metrics.service.js";
import { AdminGuard } from "../admin/admin.guard.js";

/**
 * `GET /admin/metrics/offers` (orchestrator addendum): instrumentation for the
 * ₹9 hypothesis (D55) — "purchase" and "upgrade within 60 days" events, and the
 * keep/replace recommendation the source doc's own thresholds imply. Same
 * `AdminGuard` convention as `AdminCreditsController` (THREAT-MODEL T20):
 * registered in `admin.module.ts`, never mounted from an ordinary feature
 * module.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/metrics")
export class AdminOffersController {
  constructor(private readonly metrics: OffersMetricsService) {}

  @Get("offers")
  @ApiOperation({
    summary: "₹9 clean-export hypothesis: purchases, upgrades within 60 days, recommendation",
    description: "`04-pricing-and-monetization.md` §Offers; `12-redesign-decisions.md` D55.",
    operationId: "getOffersMetrics",
  })
  @ApiOkResponse({ description: "Purchase/upgrade counts, conversion rate, keep/replace verdict." })
  async offers(): Promise<{ ninePass: NinePassHypothesisMetrics }> {
    return { ninePass: await this.metrics.ninePassHypothesis() };
  }
}
