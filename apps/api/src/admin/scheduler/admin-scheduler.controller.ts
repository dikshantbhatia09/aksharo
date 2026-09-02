import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import { Audited } from "../../audit/audited.decorator.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { ScheduledTasksService } from "../../common/scheduler/scheduled-tasks.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * The manual trigger every scheduled task needs (B16 brief §1: "each task is
 * idempotent, logged with counts, and has a manual trigger endpoint for
 * admins").
 *
 * One controller for every task registered with {@link ScheduledTasksService}
 * — B02's credit sweeps, B06's streak rollover, B07's commission maturation
 * and payout batch, A08/A08c's job-event retention and DLQ depth, and every
 * task B16 itself registers — rather than one admin route per task, because
 * the set of tasks is `ScheduledTasksService.registered` and a route per name
 * would drift from it the first time a work package adds one. `runNow` is the
 * exact seam `common/scheduler/scheduled-tasks.service.ts` built for a test to
 * bypass the clock; this is that seam behind {@link AdminGuard} instead.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/scheduler")
export class AdminSchedulerController {
  constructor(
    private readonly scheduler: ScheduledTasksService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("tasks")
  @ApiOperation({
    summary: "Every scheduled task's name",
    operationId: "listScheduledTasks",
  })
  @ApiOkResponse({ description: "`{tasks: string[]}`." })
  list(): { tasks: readonly string[] } {
    return { tasks: this.scheduler.registered };
  }

  @Post("tasks/:name/run")
  @HttpCode(HttpStatus.OK)
  @Audited("admin.scheduler.task_run")
  @ApiOperation({
    summary: "Run one scheduled task now, out of band",
    description:
      "Bypasses the clock and runs the task in this process immediately. Every " +
      "task is idempotent, so running one early never double-counts.",
    operationId: "runScheduledTaskNow",
  })
  @ApiOkResponse({ description: "`{name, ranAt}`." })
  @ApiNotFoundResponse({ description: "No task with that name is registered." })
  async run(
    @Param("name") name: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ name: string; ranAt: string }> {
    const admin = adminOf(request);
    if (!this.scheduler.registered.includes(name)) {
      throw new AppException(
        ERROR_CODES.notFound,
        `No scheduled task named "${name}".`,
        HttpStatus.NOT_FOUND,
      );
    }
    await this.scheduler.runNow(name);
    const ranAt = new Date().toISOString();
    await this.audit.record({
      action: "admin.scheduler.task_run",
      resource: "scheduled_task",
      resourceId: name,
      actorId: admin.userId,
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { name },
    });
    return { name, ranAt };
  }
}
