import { Controller, Get, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { streakCohortMetricsSchema, type StreakCohortMetrics } from "./admin-streak.dto.js";
import { AdminStreakService } from "./admin-streak.service.js";
import { zodResponse } from "../../auth/dto/openapi.js";
import { AdminGuard } from "../admin.guard.js";

/** `/admin/metrics/streak` — cohort measurement for the streak experiment (B06 brief §5). */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/metrics/streak")
export class AdminStreakController {
  constructor(private readonly metrics: AdminStreakService) {}

  @Get()
  @ApiOperation({
    summary: "Streak experiment vs holdout cohort metrics",
    description: "Week-4 retention and export frequency, per 04 §Streak rewards.",
    operationId: "getStreakCohortMetrics",
  })
  @ApiOkResponse(zodResponse(streakCohortMetricsSchema, "Experiment vs holdout cohort metrics."))
  async get(): Promise<StreakCohortMetrics> {
    return this.metrics.cohortMetrics();
  }
}
