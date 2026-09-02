import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { BATCH_RATE_LIMITS } from "./batch.constants.js";
import {
  ApplyBatchDto,
  applyBatchSchema,
  batchQuoteSchema,
  batchViewSchema,
  BatchQuoteDto,
  CreateBatchDto,
  createBatchSchema,
} from "./batch.dto.js";
import { BatchService } from "./batch.service.js";
import { zodBody, zodResponse } from "../auth/dto/openapi.js";
import {
  CurrentUser,
  CurrentWorkspace,
  JwtAuthGuard,
  RateLimit,
  RateLimitGuard,
  Roles,
  RolesGuard,
} from "../common/guards/index.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { BatchQuote, BatchView } from "./batch.service.js";

/**
 * Batch: quote, create (tags N projects with a `batch_id`), apply (enqueues
 * transcription per project) and the progress view (B15 brief §4).
 *
 * Guard chain matches `ProjectsController`: `JwtAuthGuard` +
 * `WorkspaceMemberGuard` + `RolesGuard`, `editor` to create/apply, `viewer` to
 * read progress.
 */
@ApiTags("batch")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("batch")
export class BatchController {
  constructor(private readonly batch: BatchService) {}

  @Post("quote")
  @Roles("editor")
  @ApiOperation({ summary: "Quote a batch's transcription credits", operationId: "quoteBatch" })
  @ApiBody(zodBody(batchQuoteSchema))
  quote(@Body() body: BatchQuoteDto): BatchQuote {
    return this.batch.quote(body.items.map((item) => item.durationMs));
  }

  @Post()
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(BATCH_RATE_LIMITS.create)
  @ApiOperation({
    summary: "Create a batch of projects",
    description: "Creates N projects (via A06's batch-create) tagged with one batch id.",
    operationId: "createBatch",
  })
  @ApiBody(zodBody(createBatchSchema))
  @ApiOkResponse(zodResponse(batchViewSchema, "The new batch and its projects."))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: CreateBatchDto,
  ): Promise<BatchView> {
    return this.batch.create(workspaceId, userId, body);
  }

  @Post(":batchId/apply")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(BATCH_RATE_LIMITS.apply)
  @ApiOperation({
    summary: "Enqueue transcription for every project in the batch",
    operationId: "applyBatch",
  })
  @ApiBody(zodBody(applyBatchSchema))
  async apply(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("batchId") batchId: string,
    @Body() body: ApplyBatchDto,
  ): Promise<BatchView> {
    return this.batch.apply(workspaceId, userId, batchId, body);
  }

  @Get(":batchId")
  @Roles("viewer")
  @ApiOperation({ summary: "Batch progress: per-project status", operationId: "getBatch" })
  @ApiOkResponse(zodResponse(batchViewSchema, "The batch and its per-project status."))
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("batchId") batchId: string,
  ): Promise<BatchView> {
    return this.batch.get(workspaceId, batchId);
  }
}
