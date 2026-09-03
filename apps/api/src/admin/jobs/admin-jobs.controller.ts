import { Controller, Get, HttpStatus, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { AdminJobSummaryDto, AdminListJobsQueryDto, AdminQueueStatsDto } from "./admin-jobs.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { JobsService } from "../../jobs/jobs.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";
import type { Job } from "@prisma/client";

/**
 * Cross-tenant job monitor (B13 scope §2: "job monitor (queues, counts,
 * failed, DLQ) + replay (A08b) + cancel"). The dead-letter half of this
 * (replay/discard) is A08b's existing \`AdminDlqController\` — this adds the
 * live-queue half: every job, any workspace, plus cancel.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "Requires an admin session." })
@UseGuards(AdminGuard)
@Controller("admin/jobs")
export class AdminJobsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List jobs across every workspace", operationId: "adminListJobs" })
  @ApiOkResponse({ type: [AdminJobSummaryDto] })
  async list(@Query() query: AdminListJobsQueryDto): Promise<AdminJobSummaryDto[]> {
    const rows = await this.prisma.job.findMany({
      where: {
        ...(query.queue === undefined ? {} : { type: query.queue }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.workspaceId === undefined ? {} : { workspaceId: query.workspaceId }),
      },
      orderBy: { queuedAt: "desc" },
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      take: query.limit,
    });
    return rows.map(toSummary);
  }

  @Get("stats")
  @ApiOperation({ summary: "Per-queue counts by status", operationId: "adminJobQueueStats" })
  @ApiOkResponse({ type: [AdminQueueStatsDto] })
  async stats(): Promise<AdminQueueStatsDto[]> {
    const rows = await this.prisma.job.groupBy({
      by: ["type", "status"],
      _count: { _all: true },
    });
    const byQueue = new Map<string, AdminQueueStatsDto>();
    for (const row of rows) {
      const entry = byQueue.get(row.type) ?? {
        queue: row.type,
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 0,
        cancelled: 0,
      };
      entry[row.status] = row._count._all;
      byQueue.set(row.type, entry);
    }
    return [...byQueue.values()].sort((a, b) => a.queue.localeCompare(b.queue));
  }

  @Post(":id/cancel")
  @ApiOperation({
    summary: "Cancel a queued/running job in any workspace",
    operationId: "adminCancelJob",
  })
  @ApiOkResponse({ type: AdminJobSummaryDto })
  @ApiNotFoundResponse({ description: "`common/not_found`." })
  async cancel(
    @Param("id") id: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdminJobSummaryDto> {
    const job = await this.prisma.job.findUnique({ where: { id }, select: { workspaceId: true } });
    if (job === null) {
      throw new AppException(ERROR_CODES.notFound, "No such job.", HttpStatus.NOT_FOUND);
    }
    const cancelled = await this.jobs.cancel(id, job.workspaceId);
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.jobs.cancelled",
      resource: "job",
      resourceId: id,
      workspaceId: job.workspaceId,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
    });
    return toSummary(cancelled);
  }
}

function toSummary(job: Job): AdminJobSummaryDto {
  return {
    id: job.id,
    workspaceId: job.workspaceId,
    type: job.type,
    status: job.status,
    attemptNo: job.attemptNo,
    error: job.error,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}
