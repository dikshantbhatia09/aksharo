import { Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  JobDto,
  JobEventPageDto,
  JobPageDto,
  ListEventsQueryDto,
  ListJobsQueryDto,
  toJobDto,
  toJobEventDto,
} from "./jobs.dto.js";
import { JobsService } from "./jobs.service.js";
import { AccessTokenGuard, principalOf } from "../realtime/auth/access-token.guard.js";

import type { AuthenticatedRequest } from "../realtime/auth/access-token.guard.js";

/**
 * The public jobs API.
 *
 * Read-and-cancel only: **creating** a job is never a client's call, it is the
 * consequence of uploading media (A06/A07), asking for a transcript (A11) or
 * starting an export (A21), and each of those owns the credit quote for its own
 * work. Producers use `JobsService.enqueue` directly.
 *
 * Every route is scoped to the caller's workspace from the token's `ws` claim
 * (THREAT-MODEL T4, T5): a job id from another workspace is a 404, not a 403, so
 * the endpoint cannot be used to test whether an id exists.
 */
@ApiTags("jobs")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@UseGuards(AccessTokenGuard)
@Controller("jobs")
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  @ApiOperation({
    summary: "List the workspace's jobs, newest first",
    description:
      "Cursor pagination: pass the previous page's `nextCursor` as `cursor`. " +
      "Ids are ULIDs, so the cursor is stable and ordered by creation time.",
    operationId: "listJobs",
  })
  @ApiOkResponse({ type: JobPageDto })
  async list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListJobsQueryDto,
  ): Promise<JobPageDto> {
    const principal = principalOf(request);
    const page = await this.jobs.list({ workspaceId: principal.ws, ...query });
    return { items: page.items.map(toJobDto), nextCursor: page.nextCursor };
  }

  @Get(":id")
  @ApiOperation({ summary: "Fetch one job", operationId: "getJob" })
  @ApiOkResponse({ type: JobDto })
  @ApiNotFoundResponse({ description: "`jobs/not_found`." })
  async get(@Req() request: AuthenticatedRequest, @Param("id") id: string): Promise<JobDto> {
    const principal = principalOf(request);
    return toJobDto(await this.jobs.get(id, principal.ws));
  }

  @Get(":id/events")
  @ApiOperation({
    summary: "The job's event log, oldest first",
    description: "Rows are purged 30 days after they are written (`data.retainUntil`).",
    operationId: "listJobEvents",
  })
  @ApiOkResponse({ type: JobEventPageDto })
  @ApiNotFoundResponse({ description: "`jobs/not_found`." })
  async events(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
    @Query() query: ListEventsQueryDto,
  ): Promise<JobEventPageDto> {
    const principal = principalOf(request);
    const page = await this.jobs.listEvents(id, principal.ws, query);
    return {
      items: page.items.map(toJobEventDto),
      nextCursor: page.nextCursor,
    };
  }

  @Post(":id/cancel")
  @ApiOperation({
    summary: "Cancel a queued or running job",
    description: "Releases the credit hold. A finished job is `jobs/invalid_state` (409).",
    operationId: "cancelJob",
  })
  @ApiOkResponse({ type: JobDto })
  @ApiNotFoundResponse({ description: "`jobs/not_found`." })
  @ApiConflictResponse({ description: "`jobs/invalid_state`." })
  async cancel(@Req() request: AuthenticatedRequest, @Param("id") id: string): Promise<JobDto> {
    const principal = principalOf(request);
    return toJobDto(await this.jobs.cancel(id, principal.ws));
  }
}
