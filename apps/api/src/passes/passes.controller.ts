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
} from "@nestjs/swagger";

import {
  PassAcceptedDto,
  PassSummaryListDto,
  StartAutocutRequestDto,
  StartReframeRequestDto,
  StartZoomRequestDto,
} from "./passes.dto.js";
import { PassesService } from "./passes.service.js";
import { CurrentUser, JwtAuthGuard, Roles, RolesGuard } from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { AuthPrincipal } from "../common/guards/index.js";

/**
 * The edit-passes surface (B18): start an autocut pass, read the passes a
 * project has landed.
 *
 * Same tenancy and role rules as `TranscriptsController`: `(projectId,
 * workspaceId)` always, a project belonging to somebody else is a 404
 * (THREAT-MODEL T4, T5), producing needs `editor`, reading needs `viewer`.
 *
 * `GET /projects/{id}/passes` is a thin read over `EdgService.passes`, the
 * same data `GET /projects/{id}/edg/passes` (A12) already serves — this route
 * exists because the brief names it directly under `/passes`, not because the
 * read is implemented twice.
 */
@ApiTags("passes")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiNotFoundResponse({ description: "`common/not_found`." })
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("projects/:projectId/passes")
export class PassesController {
  constructor(private readonly passes: PassesService) {}

  @Post("autocut")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Start an autocut pass",
    description:
      "Quotes the job from the primary media's probed duration (`autocutPass` burn rate, " +
      "source minutes), holds the credits and enqueues `ai.pass`. The proposed cuts land as " +
      "`edg_pass_items` (state `proposed`) once the worker's completion arrives and " +
      "`MergePass` merges them; watch `job.completed` on the project's realtime room, or " +
      "poll `GET /jobs/{id}`.",
    operationId: "startAutocutPass",
  })
  @ApiOkResponse({ type: PassAcceptedDto, description: "Accepted and queued." })
  @ApiConflictResponse({ description: "`pass/media_not_ready` or `pass/transcript_not_ready`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async startAutocut(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: StartAutocutRequestDto,
  ): Promise<PassAcceptedDto> {
    return this.passes.startAutocut({
      projectId,
      workspaceId: principal.workspaceId,
      preset: body.preset,
      ...(body.options === undefined ? {} : { options: body.options }),
    });
  }

  @Post("zoom")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Start a zoom pass",
    description:
      "Quotes the job from the primary media's probed duration (`reframeZoomPass` burn " +
      "rate, source minutes), holds the credits and enqueues `ai.pass`. Proposed punch-in " +
      "events land as `edg_pass_items` (kind `zoom`, state `proposed`) once the worker's " +
      "completion arrives and `MergePass` merges them; watch `job.completed` on the " +
      "project's realtime room, or poll `GET /jobs/{id}`.",
    operationId: "startZoomPass",
  })
  @ApiOkResponse({ type: PassAcceptedDto, description: "Accepted and queued." })
  @ApiConflictResponse({ description: "`pass/media_not_ready`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async startZoom(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: StartZoomRequestDto,
  ): Promise<PassAcceptedDto> {
    return this.passes.startZoom({
      projectId,
      workspaceId: principal.workspaceId,
      preset: body.preset,
    });
  }

  @Post("reframe")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Start a reframe pass",
    description:
      "Quotes the job from the primary media's probed duration (`reframeZoomPass` burn " +
      "rate, source minutes), holds the credits and enqueues `ai.pass`. A crop-window " +
      "keyframe curve lands as one `edg_pass_items` row (kind `reframe`, state " +
      "`proposed`) once the worker's completion arrives and `MergePass` merges it; watch " +
      "`job.completed` on the project's realtime room, or poll `GET /jobs/{id}`.",
    operationId: "startReframePass",
  })
  @ApiOkResponse({ type: PassAcceptedDto, description: "Accepted and queued." })
  @ApiConflictResponse({ description: "`pass/media_not_ready`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async startReframe(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
    @Body() body: StartReframeRequestDto,
  ): Promise<PassAcceptedDto> {
    return this.passes.startReframe({
      projectId,
      workspaceId: principal.workspaceId,
      aspect: body.aspect,
      ...(body.options === undefined ? {} : { options: body.options }),
    });
  }

  @Post("textfx")
  @Roles("editor")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: "Start a text-fx pass",
    description:
      "Quotes the job from the finished (post-cut) timeline (`textFxPass` burn rate, " +
      "finished minutes), holds the credits and enqueues `ai.pass`. Key-phrase title " +
      "proposals land as `edg_pass_items` (kind `title`, state `proposed`) once the " +
      "worker's completion arrives and `MergePass` merges them; watch `job.completed` on " +
      "the project's realtime room, or poll `GET /jobs/{id}`.",
    operationId: "startTextFxPass",
  })
  @ApiOkResponse({ type: PassAcceptedDto, description: "Accepted and queued." })
  @ApiConflictResponse({ description: "`pass/media_not_ready` or `pass/transcript_not_ready`." })
  @ApiPaymentRequiredResponse({ description: "`credits/insufficient`." })
  async startTextFx(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<PassAcceptedDto> {
    return this.passes.startTextFx({ projectId, workspaceId: principal.workspaceId });
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({
    summary: "Every pass this project has landed, with items",
    operationId: "listProjectPasses",
  })
  @ApiOkResponse({ type: PassSummaryListDto })
  async list(
    @CurrentUser() principal: AuthPrincipal,
    @Param("projectId") projectId: string,
  ): Promise<PassSummaryListDto> {
    return { passes: await this.passes.list(projectId, principal.workspaceId) };
  }
}
