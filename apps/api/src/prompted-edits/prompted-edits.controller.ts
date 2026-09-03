import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPaymentRequiredResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";

import type { EditPlanOutput } from "@montaj/prompts";

import {
  CreatePlanRequestDto,
  PromptedEditPlanDto,
  RunPlanAcceptedDto,
} from "./prompted-edits.dto.js";
import { PromptedEditsService } from "./prompted-edits.service.js";
import { CommonAuditService } from "../common/audit/audit.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";
import type { PromptedEditPlan } from "@prisma/client";

/**
 * `/projects/{id}/prompted-edits` (D07): plan (LLM plan preview) then run
 * (dependency-ordered pass chain).
 *
 * Same tenancy/role split as `PassesController`/`InsightsController`:
 * `editor` to spend credits and start work, `viewer` to read a plan back for
 * the preview sheet.
 */
@ApiTags("prompted-edits")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found` or `prompted_edit/plan_not_found`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/prompted-edits")
export class PromptedEditsController {
  constructor(
    private readonly promptedEdits: PromptedEditsService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post()
  @Roles("editor")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Generate a prompted-edit plan from a free-text instruction",
    description:
      "Calls the edit-plan@1 planner with the project's own facts (duration, language, " +
      "existing styles, plan tier), re-checks the result's guardrails (known pass kinds/params, " +
      "budget cap, engine-tier allowlist) and stores it as a plan for the preview sheet. " +
      "Nothing runs until POST .../{planId}/run.",
    operationId: "createPromptedEditPlan",
  })
  @ApiOkResponse({ type: PromptedEditPlanDto })
  @ApiConflictResponse({ description: "`prompted_edit/media_not_ready`." })
  @ApiUnprocessableEntityResponse({ description: "`prompted_edit/guardrail_violation`." })
  async create(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: CreatePlanRequestDto,
  ): Promise<PromptedEditPlanDto> {
    const row = await this.promptedEdits.plan({
      projectId,
      workspaceId: principal.workspaceId,
      prompt: body.prompt,
      engine: body.engine,
    });
    await this.audit.record({
      action: "prompted_edit.plan.created",
      resource: "prompted_edit_plan",
      resourceId: row.id,
      workspaceId: principal.workspaceId,
      actorId: principal.userId,
      actorKind: principal.kind,
      data: { projectId, engine: body.engine, prompt: body.prompt },
    });
    return toDto(row);
  }

  @Get(":planId")
  @Roles("viewer")
  @ApiOperation({ summary: "Read a prompted-edit plan back", operationId: "getPromptedEditPlan" })
  @ApiOkResponse({ type: PromptedEditPlanDto })
  async get(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Param("planId") planId: string,
  ): Promise<PromptedEditPlanDto> {
    const row = await this.promptedEdits.get(projectId, principal.workspaceId, planId);
    return toDto(row);
  }

  @Post(":planId/run")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Run an accepted prompted-edit plan",
    description:
      "Holds credits on the plan's source duration and enqueues the first pass of the plan's " +
      "dependency-ordered chain (autocut -> zoom/reframe -> sfx/music -> textfx); watch " +
      "`job.completed` on the project's realtime room as each pass lands, and poll " +
      "GET .../{planId} for `status`.",
    operationId: "runPromptedEditPlan",
  })
  @ApiOkResponse({ type: RunPlanAcceptedDto })
  @ApiConflictResponse({ description: "`prompted_edit/invalid_status`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async run(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Param("planId") planId: string,
  ): Promise<RunPlanAcceptedDto> {
    const result = await this.promptedEdits.run(projectId, principal.workspaceId, planId);
    await this.audit.record({
      action: "prompted_edit.plan.run",
      resource: "prompted_edit_plan",
      resourceId: planId,
      workspaceId: principal.workspaceId,
      actorId: principal.userId,
      actorKind: principal.kind,
      data: { projectId },
    });
    return result;
  }
}

function toDto(row: PromptedEditPlan): PromptedEditPlanDto {
  const output = row.plan as unknown as EditPlanOutput;
  return {
    id: row.id,
    prompt: row.prompt,
    engine: row.engine,
    passes: output.passes,
    rationale: [...output.rationale],
    status: row.status,
    holdTenths: row.holdTenths ?? 0,
    holdCredits: ((row.holdTenths ?? 0) / 10).toFixed(1),
    createdAt: row.createdAt.toISOString(),
    ...(output.style === undefined ? {} : { style: output.style }),
    ...(output.script === undefined ? {} : { script: output.script }),
    ...(row.settledTenths === null || row.settledTenths === undefined
      ? {}
      : { settledTenths: row.settledTenths }),
  };
}
