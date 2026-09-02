import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { acquisitionMetricsSchema, type AcquisitionMetrics } from "./admin-acquisition.dto.js";
import { AdminAcquisitionService } from "./admin-acquisition.service.js";
import { zodResponse } from "../../auth/dto/openapi.js";
import { AdminGuard } from "../admin.guard.js";

/**
 * `/admin/metrics/acquisition` — onboarding source and code-type breakdown
 * (B17 brief §2). Same shape as `AdminStreakController`: guard-only, no
 * workspace scoping, `?days=` bounds the trailing window.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/metrics/acquisition")
export class AdminAcquisitionController {
  constructor(private readonly metrics: AdminAcquisitionService) {}

  @Get()
  @ApiOperation({
    summary: "Onboarding completions by source and code type",
    description: "Launch-metrics instrumentation (13-launch-plan.md); trailing 30 days by default.",
    operationId: "getAcquisitionMetrics",
  })
  @ApiQuery({ name: "days", required: false, type: Number })
  @ApiOkResponse(zodResponse(acquisitionMetricsSchema, "Onboarding completions, grouped."))
  async get(@Query("days") days?: string): Promise<AcquisitionMetrics> {
    const parsed = days === undefined ? undefined : Number.parseInt(days, 10);
    const windowDays =
      parsed !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    return this.metrics.metrics(windowDays);
  }
}
