import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  streakTestHookSchema,
  streakViewSchema,
  StreakTestHookDto,
  type StreakView,
} from "./streak.dto.js";
import { StreakService } from "./streak.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import { AppException, ERROR_CODES } from "../common/errors/error-codes.js";
import { CurrentUser, JwtAuthGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/streak/*` (B06 brief §3). `GET /streak` answers for the caller's own
 * workspace, exactly like `/billing/subscription` (no `:id` in the path —
 * `WorkspaceMemberGuard` scopes it through the access token). The test-hook
 * route only exists outside production (see its own guard below) so a
 * Playwright/e2e suite can drive weeks forward without waiting a real week.
 */
@ApiTags("streak")
@Controller("streak")
export class StreakController {
  constructor(private readonly streak: StreakService) {}

  @Get()
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
  @ApiBearerAuth("access-token")
  @ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
  @ApiOperation({ summary: "This workspace's streak state", operationId: "getStreak" })
  @ApiOkResponse(zodResponse(streakViewSchema, "Streak state; `eligible:false` when not assigned."))
  async getStreak(@CurrentUser() principal: AuthPrincipal): Promise<StreakView> {
    return this.streak.getView(principal.workspaceId);
  }

  @Post("test-hooks")
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard)
  @ApiBearerAuth("access-token")
  @ApiForbiddenResponse({ description: "`common/forbidden` outside a test environment." })
  @ApiOperation({
    summary: "Simulate weeks (test environment only)",
    operationId: "streakTestHooks",
  })
  @ApiBody(zodBody(streakTestHookSchema))
  async testHooks(
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: StreakTestHookDto,
  ): Promise<void> {
    if (process.env["NODE_ENV"] === "production") {
      throw new AppException(
        ERROR_CODES.forbidden,
        "Test hooks are unavailable outside a test environment.",
        HttpStatus.FORBIDDEN,
      );
    }
    await this.streak.ensureAssigned(principal.workspaceId);
    if (body.publishDays !== undefined) {
      await this.streak.simulatePublishDays(principal.workspaceId, body.publishDays);
    }
    if (body.resetMonth === true) {
      await this.streak.forceMonthReset(principal.workspaceId);
    }
    if (body.rolloverWeek === true) {
      await this.streak.forceRollover(principal.workspaceId);
    }
  }
}
