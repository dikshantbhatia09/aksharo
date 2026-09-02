import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { CreditsQueryService } from "./credits-query.service.js";
import {
  CreditsSummaryDto,
  ListUsageQueryDto,
  toCreditsSummaryDto,
  toUsagePageDto,
  UsagePageDto,
} from "./credits.dto.js";
import { JwtAuthGuard, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

/**
 * `GET /workspaces/{id}/usage` and `GET /workspaces/{id}/credits` — brief §7.
 *
 * Wears the same `JwtAuthGuard, WorkspaceMemberGuard, RolesGuard` triple as every
 * other `/workspaces/:id/*` route (THREAT-MODEL T4); `test/workspace-guard.
 * e2e-spec.ts` enumerates the live route table rather than a fixed list, so this
 * controller is covered by that suite without editing it.
 */
@ApiTags("credits")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`auth/not_a_member`." })
@Controller("workspaces/:id")
export class CreditsController {
  constructor(private readonly query: CreditsQueryService) {}

  @Get("credits")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiOperation({
    summary: "Balance, next grant reset, and live lots",
    description:
      "Lots are listed in consumption order: soonest-expiring first, then FIFO " +
      "(D32) — the same order `reserve` draws from them.",
    operationId: "getWorkspaceCredits",
  })
  @ApiOkResponse({ type: CreditsSummaryDto })
  async credits(@Param("id") id: string): Promise<CreditsSummaryDto> {
    return toCreditsSummaryDto(await this.query.getSummary(id));
  }

  @Get("usage")
  @UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
  @ApiOperation({
    summary: "Ledger history, newest first",
    description:
      "Every balance move this workspace's account has ever recorded, with " +
      'per-job attribution where `refType` is `"job"`. Cursor pagination: pass ' +
      "the previous page's `nextCursor`.",
    operationId: "getWorkspaceUsage",
  })
  @ApiOkResponse({ type: UsagePageDto })
  async usage(@Param("id") id: string, @Query() query: ListUsageQueryDto): Promise<UsagePageDto> {
    return toUsagePageDto(await this.query.getUsage(id, query));
  }
}
