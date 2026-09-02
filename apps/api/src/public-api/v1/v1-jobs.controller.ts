import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ApiKeyRateLimitGuard } from "./api-key-rate-limit.guard.js";
import { V1JobDto } from "./v1.dto.js";
import { ApiKeyGuard, ApiScopes, CurrentUser } from "../../common/guards/index.js";
import { JobsService } from "../../jobs/jobs.service.js";

import type { AuthPrincipal } from "../../common/guards/index.js";

@ApiTags("public")
@ApiSecurity("api-key")
@ApiUnauthorizedResponse({ description: "Missing or invalid `X-Api-Key`." })
@ApiForbiddenResponse({ description: "The key lacks the required scope." })
@UseGuards(ApiKeyGuard, ApiKeyRateLimitGuard)
@Controller("v1/jobs")
export class V1JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get(":id")
  @ApiScopes("projects_read")
  @ApiOperation({ summary: "Poll a job's status", operationId: "v1GetJob" })
  @ApiOkResponse({ type: V1JobDto })
  async get(@CurrentUser() principal: AuthPrincipal, @Param("id") id: string): Promise<V1JobDto> {
    const job = await this.jobs.get(id, principal.workspaceId);
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.progress,
      error: job.error,
      createdAt: job.queuedAt.toISOString(),
    };
  }
}
