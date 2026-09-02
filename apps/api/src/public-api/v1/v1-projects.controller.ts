import { Body, Controller, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { ApiKeyRateLimitGuard } from "./api-key-rate-limit.guard.js";
import { IdempotencyService } from "./idempotency.service.js";
import { withIdempotency } from "./idempotent.helper.js";
import { SourceUrlIngestService } from "./source-url-ingest.service.js";
import { V1CreateProjectRequestDto, V1ProjectDto } from "./v1.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { ApiKeyGuard, ApiScopes, CurrentUser } from "../../common/guards/index.js";
import { ProjectsService } from "../../projects/projects.service.js";

import type { AuthPrincipal } from "../../common/guards/index.js";
import type { Request } from "express";

/**
 * `/v1/projects` (B14 §2): `X-Api-Key` only, never a session cookie/JWT — this
 * is the customer-integration surface, not the web app's own API.
 */
@ApiTags("public")
@ApiSecurity("api-key")
@ApiUnauthorizedResponse({ description: "Missing or invalid `X-Api-Key`." })
@ApiForbiddenResponse({ description: "The key lacks the required scope." })
@UseGuards(ApiKeyGuard, ApiKeyRateLimitGuard)
@Controller("v1/projects")
export class V1ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly ingest: SourceUrlIngestService,
    private readonly idempotency: IdempotencyService,
    private readonly audit: CommonAuditService,
  ) {}

  @Post()
  @ApiScopes("projects_write")
  @ApiOperation({
    summary: "Create a project, optionally from a sourceUrl",
    description:
      "`sourceUrl` is fetched under the SSRF guard (https only, private/link-local/metadata " +
      "addresses refused, redirects re-validated) and attached as the project's primary media.",
    operationId: "v1CreateProject",
  })
  @ApiOkResponse({ type: V1ProjectDto })
  async create(
    @Req() request: Request,
    @CurrentUser() principal: AuthPrincipal,
    @Body() body: V1CreateProjectRequestDto,
  ): Promise<V1ProjectDto> {
    return withIdempotency(
      this.idempotency,
      request,
      principal.workspaceId,
      "POST /v1/projects",
      body,
      async () => {
        const project = await this.projects.create(principal.workspaceId, principal.userId, {
          title: body.title,
        });
        if (body.sourceUrl !== undefined) {
          const raw = await this.projects.requireProject(principal.workspaceId, project.id);
          await this.ingest.ingest(principal.workspaceId, raw, body.sourceUrl);
        }
        await this.audit.record({
          action: "public_api.project.created",
          resource: "project",
          resourceId: project.id,
          actorId: principal.userId,
          actorKind: "api",
          workspaceId: principal.workspaceId,
          data: { title: body.title, fromSourceUrl: body.sourceUrl !== undefined },
        });
        return toDto(project);
      },
    );
  }

  @Get(":id")
  @ApiScopes("projects_read")
  @ApiOperation({ summary: "Fetch a project", operationId: "v1GetProject" })
  @ApiOkResponse({ type: V1ProjectDto })
  async get(
    @CurrentUser() principal: AuthPrincipal,
    @Param("id") id: string,
  ): Promise<V1ProjectDto> {
    const project = await this.projects.get(principal.workspaceId, id);
    return toDto(project);
  }
}

function toDto(project: {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly createdAt: string;
}): V1ProjectDto {
  return {
    id: project.id,
    title: project.title,
    status: project.status,
    durationMs: project.durationMs,
    createdAt: project.createdAt,
  };
}
