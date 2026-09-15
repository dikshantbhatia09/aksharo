import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { REPURPOSE_RATE_LIMITS } from "./repurpose.constants.js";
import {
  CreateRunDto,
  ListRunsDto,
  createRunResponseSchema,
  createRunSchema,
  runPageSchema,
  runViewSchema,
} from "./repurpose.dto.js";
import { RepurposeService } from "./repurpose.service.js";
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
import { IdempotencyService } from "../public-api/v1/idempotency.service.js";
import { withIdempotency } from "../public-api/v1/idempotent.helper.js";
import { WorkspaceMemberGuard } from "../workspaces/workspace-member.guard.js";

import type { CreateRunResponse, RunPage, RunView } from "./repurpose.dto.js";
import type { Request } from "express";

/**
 * `/repurpose/runs` — the guided run's CRUD surface (REP-006).
 *
 * Guard chain is the one every workspace-scoped module uses: `JwtAuthGuard` +
 * `WorkspaceMemberGuard` + `RolesGuard`, `editor` to change anything, `viewer` to
 * read. The workspace id comes from the verified token, never from the path, so
 * there is no id a caller can substitute.
 *
 * `create`, `cancel` and `retry` all honour `Idempotency-Key` through the same
 * `IdempotencyService` the public API uses: a retried POST after a dropped
 * response replays the first answer instead of starting a second run. Without
 * the header they behave normally, which is what a browser form does.
 *
 * What that helper promises is SEQUENTIAL replay — the second request arrives
 * after the first has been recorded. It is check-then-act, so two genuinely
 * concurrent requests carrying one key can both miss the record and both run
 * (`idempotent.helper.ts`). That window is shared with every `/v1` route and is
 * not this module's to close unilaterally; what keeps it from mattering here is
 * that the expensive, externally-visible half of a run is guarded again further
 * down — `repurpose_runs_live_source_idx` admits one live run per source, and
 * Wave 3's acquisition is keyed on the source fingerprint, so a duplicated create
 * yields a second draft row rather than a second download or transcription.
 * Closing the window properly means reserving the key with an insert before the
 * work runs, and belongs in a change that covers `/v1` too.
 *
 * Every route answers 404 while `repurpose_flow` is off, which is how it ships.
 */
@ApiTags("repurpose")
@ApiBearerAuth("access-token")
@UseGuards(JwtAuthGuard, WorkspaceMemberGuard, RolesGuard)
@Controller("repurpose/runs")
export class RepurposeController {
  constructor(
    private readonly repurpose: RepurposeService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(REPURPOSE_RATE_LIMITS.create)
  @ApiOperation({
    summary: "Start a repurposing run from a link or an upload",
    description:
      "Creates the source project and, for an upload, the normal multipart ticket. " +
      "The run is persisted before any background work, so a refresh never loses it.",
    operationId: "createRepurposeRun",
  })
  @ApiBody(zodBody(createRunSchema))
  @ApiOkResponse(zodResponse(createRunResponseSchema, "The new run and its upload ticket."))
  async create(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Body() body: CreateRunDto,
    @Req() request: Request,
  ): Promise<CreateRunResponse> {
    return withIdempotency(
      this.idempotency,
      request,
      workspaceId,
      "POST /repurpose/runs",
      body,
      async () => this.repurpose.create(workspaceId, userId, body),
    );
  }

  @Get()
  @Roles("viewer")
  @ApiOperation({ summary: "List repurposing runs", operationId: "listRepurposeRuns" })
  @ApiOkResponse(zodResponse(runPageSchema, "One page of runs, newest first."))
  async list(
    @CurrentWorkspace() workspaceId: string,
    @Query() query: ListRunsDto,
  ): Promise<RunPage> {
    return this.repurpose.list(workspaceId, query);
  }

  @Get(":runId")
  @Roles("viewer")
  @ApiOperation({ summary: "Read one repurposing run", operationId: "getRepurposeRun" })
  @ApiOkResponse(zodResponse(runViewSchema, "The run and its five stages."))
  async get(
    @CurrentWorkspace() workspaceId: string,
    @Param("runId") runId: string,
  ): Promise<RunView> {
    return this.repurpose.get(workspaceId, runId);
  }

  @Post(":runId/cancel")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(REPURPOSE_RATE_LIMITS.mutate)
  @ApiOperation({
    summary: "Stop a run",
    description: "Stops future work. Anything already finished stays available.",
    operationId: "cancelRepurposeRun",
  })
  @ApiOkResponse(zodResponse(runViewSchema, "The cancelled run."))
  async cancel(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Req() request: Request,
  ): Promise<RunView> {
    return withIdempotency(
      this.idempotency,
      request,
      workspaceId,
      `POST /repurpose/runs/${runId}/cancel`,
      {},
      async () => this.repurpose.cancel(workspaceId, userId, runId),
    );
  }

  @Post(":runId/retry")
  @Roles("editor")
  @UseGuards(RateLimitGuard)
  @RateLimit(REPURPOSE_RATE_LIMITS.mutate)
  @ApiOperation({ summary: "Try a failed run again", operationId: "retryRepurposeRun" })
  @ApiOkResponse(zodResponse(runViewSchema, "The run, ready to continue."))
  async retry(
    @CurrentWorkspace() workspaceId: string,
    @CurrentUser("userId") userId: string,
    @Param("runId") runId: string,
    @Req() request: Request,
  ): Promise<RunView> {
    return withIdempotency(
      this.idempotency,
      request,
      workspaceId,
      `POST /repurpose/runs/${runId}/retry`,
      {},
      async () => this.repurpose.retry(workspaceId, userId, runId),
    );
  }
}
