import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";

import {
  AccountReconciliationDto,
  OrphanedHoldDto,
  OrphanedHoldResolutionDto,
  ResolveOrphanedHoldsDto,
  toAccountReconciliationDto,
  toOrphanedHoldDto,
  toOrphanedHoldResolutionDto,
} from "./admin-credits.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { CreditOrphanedHoldsService } from "../../credits/credit-orphaned-holds.service.js";
import { CreditReconcileService } from "../../credits/credit-reconcile.service.js";
import { AdminGuard, adminOf } from "../admin.guard.js";

import type { AuthenticatedRequest } from "../../common/guards/principal.js";

/**
 * The platform-staff surface behind `tools/runbooks/credits-orphaned-holds.js`
 * and `tools/runbooks/billing-reconcile.js`, in the same spirit as
 * `AdminDlqController`: a script drives the admin API over HTTP rather than
 * opening its own database connection, so the policy (what "orphaned" means,
 * what reconciliation compares) lives in exactly one place.
 */
@ApiTags("admin")
@ApiBearerAuth("access-token")
@ApiUnauthorizedResponse({ description: "Missing or invalid access token." })
@ApiForbiddenResponse({ description: "`common/forbidden` — the caller is not an administrator." })
@UseGuards(AdminGuard)
@Controller("admin/credits")
export class AdminCreditsController {
  constructor(
    private readonly orphanedHolds: CreditOrphanedHoldsService,
    private readonly reconcile: CreditReconcileService,
    private readonly audit: CommonAuditService,
  ) {}

  @Get("orphaned-holds")
  @ApiOperation({
    summary: "Holds still `held` whose job has already reached a terminal status",
    description: "`docs/runbooks/credits-orphaned-holds.md` §1.",
    operationId: "listOrphanedCreditHolds",
  })
  @ApiOkResponse({ type: [OrphanedHoldDto] })
  async listOrphanedHolds(): Promise<OrphanedHoldDto[]> {
    return (await this.orphanedHolds.find()).map(toOrphanedHoldDto);
  }

  @Post("orphaned-holds/resolve")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Settle or release orphaned holds per their job's outcome",
    description:
      "A succeeded job settles for `jobs.credits_charged_tenths`; every other " +
      "terminal status releases in full. `dryRun` defaults to true.",
    operationId: "resolveOrphanedCreditHolds",
  })
  @ApiOkResponse({ type: [OrphanedHoldResolutionDto] })
  async resolveOrphanedHolds(
    @Body() body: ResolveOrphanedHoldsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<OrphanedHoldResolutionDto[]> {
    const results = await this.orphanedHolds.resolveAll(body);
    const admin = adminOf(request);
    await this.audit.record({
      action: "admin.credits.orphaned_holds_resolved",
      resource: "credit_hold",
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { dryRun: body.dryRun, count: results.length },
    });
    return results.map(toOrphanedHoldResolutionDto);
  }

  @Get("reconcile")
  @ApiOperation({
    summary: "Reconcile every credit account (06 invariant 1)",
    description: "`docs/runbooks/billing-reconcile.md`. Detection only — never corrects drift.",
    operationId: "reconcileAllCreditAccounts",
  })
  @ApiOkResponse({ type: [AccountReconciliationDto] })
  async reconcileAll(): Promise<AccountReconciliationDto[]> {
    return (await this.reconcile.reconcileAll()).map(toAccountReconciliationDto);
  }

  @Get("reconcile/:accountId")
  @ApiOperation({ summary: "Reconcile one credit account", operationId: "reconcileCreditAccount" })
  @ApiOkResponse({ type: AccountReconciliationDto })
  async reconcileOne(@Param("accountId") accountId: string): Promise<AccountReconciliationDto> {
    return toAccountReconciliationDto(await this.reconcile.reconcile(accountId));
  }
}
