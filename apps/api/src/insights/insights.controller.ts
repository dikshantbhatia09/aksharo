import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { InsightsAcceptedDto, InsightsRequestDto, InsightsResponseDto } from "./insights.dto.js";
import { INSIGHTS_DISCLOSURE, InsightsService } from "./insights.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * `/projects/{id}/insights` (B11, F-206/F-207): chapters, summary,
 * hooks/titles/hashtags generated from the transcript.
 *
 * Same tenancy and role split as `TranscriptsController`: `@Roles("editor")`
 * to spend credits requesting a run, `@Roles("viewer")` to read the result;
 * `WorkspaceMemberGuard` re-checks membership per request rather than trusting
 * the fifteen-minute access token.
 */
@ApiTags("insights")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/insights")
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Post()
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Generate chapters, summary and/or hooks from the project's transcript",
    description:
      "Quotes and holds credits per kind (chapters 2, summary 1, hooks 2), enqueues one " +
      "`ai.llm` job per kind. Pass `regenerate: true` to force a fresh run (e.g. a different " +
      "`tone`) instead of deduplicating against an in-flight one.",
    operationId: "requestProjectInsights",
  })
  @ApiOkResponse({ type: InsightsAcceptedDto, description: "Accepted and queued." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async request(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: InsightsRequestDto,
  ): Promise<InsightsAcceptedDto> {
    const accepted = await this.insights.request({
      projectId,
      workspaceId: principal.workspaceId,
      kinds: body.kinds,
      regenerate: body.regenerate,
      ...(body.tone === undefined ? {} : { tone: body.tone }),
    });
    return { jobs: [...accepted.jobs], totalTenths: accepted.totalTenths };
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "The most recent chapters/summary/hooks result per kind",
    operationId: "getProjectInsights",
  })
  @ApiOkResponse({ type: InsightsResponseDto })
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<InsightsResponseDto> {
    const rows = await this.insights.list(projectId, principal.workspaceId);
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        templateVersion: row.templateVersion,
        provider: row.provider,
        region: row.region,
        output: row.output as Record<string, unknown>,
        usage: row.usage as Record<string, unknown>,
        createdAt: row.createdAt.toISOString(),
      })),
      disclosure: INSIGHTS_DISCLOSURE,
    };
  }
}
