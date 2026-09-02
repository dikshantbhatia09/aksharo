import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
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
import { AppException, ERROR_CODES } from "../../common/errors/error-codes.js";
import { PrismaService } from "../../common/prisma/prisma.service.js";
import { BreachIncidentsService } from "../../privacy/breach-incidents.service.js";
import { ErasureCascadeService } from "../../privacy/erasure-cascade.service.js";
import { ResidueCheckService } from "../../privacy/residue-check.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";
import type { $Enums, Prisma } from "@prisma/client";

/**
 * Breach incidents, DSR requests and the erasure cascade, for platform staff.
 *
 * `tools/runbooks/privacy-replay-tombstones.js` (the script
 * `docs/runbooks/breach-first-hour.md`'s "Getting the platform back" step
 * points at after a PITR restore) drives `replay-tombstones` below.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/privacy")
export class AdminPrivacyController {
  constructor(
    private readonly breaches: BreachIncidentsService,
    private readonly cascade: ErasureCascadeService,
    private readonly residue: ResidueCheckService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------------
  // Breach incidents
  // ---------------------------------------------------------------------

  @Get("breach-incidents")
  @ApiOperation({
    summary: "List breach incidents, newest first",
    operationId: "listBreachIncidents",
  })
  @ApiOkResponse({ description: "Array of breach incidents." })
  list() {
    return this.breaches.list();
  }

  @Post("breach-incidents")
  @Audited("admin.breach_incident.created")
  @ApiOperation({
    summary: "Open a breach incident",
    description: "Starts the 72-hour Data Protection Board notification clock from `detectedAt`.",
    operationId: "createBreachIncident",
  })
  @ApiOkResponse({ description: "The created incident." })
  async create(
    @Body() body: { scope: Prisma.InputJsonValue; affectedCount?: number; detectedAt?: string },
    @Req() request: AuthenticatedRequest,
  ) {
    const admin = adminOf(request);
    return this.breaches.create(
      {
        scope: body.scope ?? {},
        ...(body.affectedCount === undefined ? {} : { affectedCount: body.affectedCount }),
        ...(body.detectedAt === undefined ? {} : { detectedAt: new Date(body.detectedAt) }),
      },
      admin.userId,
      admin.ip,
    );
  }

  @Patch("breach-incidents/:id")
  @Audited("admin.breach_incident.updated")
  @ApiOperation({
    summary: "Update a breach incident's status or notification timestamps",
    operationId: "updateBreachIncident",
  })
  @ApiOkResponse({ description: "The updated incident." })
  @ApiNotFoundResponse({ description: "No such incident." })
  async update(
    @Param("id") id: string,
    @Body()
    body: {
      status?: $Enums.BreachStatus;
      affectedCount?: number;
      boardNotifiedAt?: string;
      usersNotifiedAt?: string;
      postmortemKey?: string;
    },
    @Req() request: AuthenticatedRequest,
  ) {
    const admin = adminOf(request);
    const updated = await this.breaches.update(
      id,
      {
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.affectedCount === undefined ? {} : { affectedCount: body.affectedCount }),
        ...(body.boardNotifiedAt === undefined
          ? {}
          : { boardNotifiedAt: new Date(body.boardNotifiedAt) }),
        ...(body.usersNotifiedAt === undefined
          ? {}
          : { usersNotifiedAt: new Date(body.usersNotifiedAt) }),
        ...(body.postmortemKey === undefined ? {} : { postmortemKey: body.postmortemKey }),
      },
      admin.userId,
      admin.ip,
    );
    if (updated === null) throw notFound("breach incident", id);
    return updated;
  }

  @Get("breach-incidents/:id/templates")
  @ApiOperation({
    summary: "Draft Board report and user notice for one incident",
    description: "Rendered from plain string templates — no LLM. A human completes every bracket.",
    operationId: "getBreachIncidentTemplates",
  })
  @ApiOkResponse({ description: "`{boardReport, userNotice}`." })
  @ApiNotFoundResponse({ description: "No such incident." })
  async templates(@Param("id") id: string) {
    const rendered = await this.breaches.templates(id);
    if (rendered === null) throw notFound("breach incident", id);
    return rendered;
  }

  // ---------------------------------------------------------------------
  // DSR requests and the erasure cascade
  // ---------------------------------------------------------------------

  @Get("dsr-requests")
  @ApiOperation({ summary: "List DSR requests, newest first", operationId: "listDsrRequests" })
  @ApiOkResponse({ description: "Array of `dsr_requests` rows." })
  listDsrRequests() {
    return this.prisma.dsrRequest.findMany({ orderBy: { receivedAt: "desc" }, take: 200 });
  }

  @Post("erasure/:dsrRequestId/run")
  @HttpCode(HttpStatus.OK)
  @Audited("privacy.erasure.cascade_run")
  @ApiOperation({
    summary: "Run (or resume) the erasure cascade for one DSR request now",
    description:
      "A no-op unless the request is `received`, so a stuck `in_progress` row from a " +
      "crashed pass is what this resumes — safe to call again.",
    operationId: "runErasureCascade",
  })
  @ApiOkResponse({ description: "The cascade report, or `null` if nothing was due." })
  async runErasure(@Param("dsrRequestId") dsrRequestId: string) {
    return this.cascade.run(dsrRequestId);
  }

  @Post("erasure/replay-tombstones")
  @HttpCode(HttpStatus.OK)
  @Audited("privacy.erasure.replay_tombstones")
  @ApiOperation({
    summary: "Re-verify (and re-run) erasure for every completed request",
    description:
      "For every `dsr_requests` row of kind `erasure` and status `completed`, sweeps " +
      "every model with a `userId`/`workspaceId` column for residue (the same check the " +
      "erasure contract test runs) and, if any is found — e.g. after a PITR restore — " +
      "re-runs the cascade for that user. `docs/runbooks/breach-first-hour.md`'s " +
      '"Getting the platform back" step and `tools/runbooks/privacy-replay-tombstones.js` ' +
      "call this.",
    operationId: "replayTombstones",
  })
  @ApiOkResponse({ description: "Per-user residue found and whether it was cleared." })
  async replayTombstones() {
    const completed = await this.prisma.dsrRequest.findMany({
      where: { kind: "erasure", status: "completed" },
      select: { id: true, userId: true },
    });

    const results: {
      userId: string;
      residueBefore: number;
      replayed: boolean;
      residueAfter: number;
    }[] = [];

    for (const request of completed) {
      const workspaces = await this.prisma.workspace.findMany({
        where: { ownerId: request.userId },
        select: { id: true },
      });
      const before = await this.residueOf(
        request.userId,
        workspaces.map((w) => w.id),
      );
      if (before === 0) {
        results.push({
          userId: request.userId,
          residueBefore: 0,
          replayed: false,
          residueAfter: 0,
        });
        continue;
      }

      // Residue found: re-open the request and run the cascade again.
      await this.prisma.dsrRequest.update({
        where: { id: request.id },
        data: { status: "received" },
      });
      await this.cascade.run(request.id);
      const after = await this.residueOf(
        request.userId,
        workspaces.map((w) => w.id),
      );
      results.push({
        userId: request.userId,
        residueBefore: before,
        replayed: true,
        residueAfter: after,
      });
    }

    return { checked: completed.length, results };
  }

  private async residueOf(userId: string, workspaceIds: readonly string[]): Promise<number> {
    let total = (await this.residue.check({ userId })).reduce((sum, hit) => sum + hit.count, 0);
    for (const workspaceId of workspaceIds) {
      total += (await this.residue.check({ workspaceId })).reduce((sum, hit) => sum + hit.count, 0);
    }
    return total;
  }
}

function notFound(resource: string, id: string): AppException {
  return new AppException(ERROR_CODES.notFound, `No ${resource} "${id}".`, HttpStatus.NOT_FOUND);
}
