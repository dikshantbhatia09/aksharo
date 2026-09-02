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
  AdjustCreditsDto,
  AdjustCreditsResultDto,
  OrphanedHoldDto,
  OrphanedHoldResolutionDto,
  ResolveOrphanedHoldsDto,
  ReverseCreditsDto,
  ReverseCreditsResultDto,
  toAccountReconciliationDto,
  toOrphanedHoldDto,
  toOrphanedHoldResolutionDto,
} from "./admin-credits.dto.js";
import { CommonAuditService } from "../../common/audit/audit.service.js";
import { CreditOrphanedHoldsService } from "../../credits/credit-orphaned-holds.service.js";
import { CreditReconcileService } from "../../credits/credit-reconcile.service.js";
import { LedgerCreditsFacade } from "../../credits/ledger-credits.facade.js";
import { AdminRoles } from "../admin-roles.decorator.js";
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
    private readonly ledger: LedgerCreditsFacade,
    private readonly audit: CommonAuditService,
  ) {}

  @Post("adjust")
  @HttpCode(HttpStatus.OK)
  @AdminRoles("finance", "superadmin")
  @ApiOperation({
    summary: "Grant a manual credit adjustment to a workspace (finance/superadmin only)",
    description:
      'Wraps CreditsFacade.grantLot(source: "adjust") — the same primitive B01 top-ups and ' +
      "B04 passes use, so the adjustment lot behaves identically in expiry and reconciliation. " +
      "Positive only: this grants, it does not debit (B02 has no cross-lot admin debit primitive " +
      "— see admin.guard.test.ts / this WP's final report for why that is out of scope here). " +
      "Reason is mandatory (min 10 chars) — every money/credit admin action is (B13 scope §1).",
    operationId: "adminAdjustCredits",
  })
  @ApiOkResponse({ type: AdjustCreditsResultDto })
  @ApiForbiddenResponse({ description: "Requires the finance or superadmin role." })
  async adjust(
    @Body() body: AdjustCreditsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<AdjustCreditsResultDto> {
    const admin = adminOf(request);
    const { lotId } = await this.ledger.grantLot({
      workspaceId: body.workspaceId,
      source: "adjust",
      tenths: body.tenths,
      reason: body.reason,
    });
    await this.audit.record({
      action: "admin.credits.adjusted",
      resource: "credit_account",
      resourceId: body.workspaceId,
      workspaceId: body.workspaceId,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { tenths: body.tenths, reason: body.reason, lotId },
    });
    return { lotId };
  }

  @Post("reverse")
  @HttpCode(HttpStatus.OK)
  @AdminRoles("finance", "superadmin")
  @ApiOperation({
    summary:
      "Reverse a settled job's credit charge back onto the workspace (finance/superadmin only)",
    description:
      "Wraps CreditsFacade.reverse() (the concrete LedgerCreditsFacade — 'beyond the frozen " +
      "interface' per that file's own doc comment, which names this WP as one of its two " +
      "intended callers alongside B01 payment refunds). Requires a prior credit_holds row for " +
      "the job. Reason is mandatory.",
    operationId: "adminReverseCredits",
  })
  @ApiOkResponse({ type: ReverseCreditsResultDto })
  @ApiForbiddenResponse({ description: "Requires the finance or superadmin role." })
  async reverse(
    @Body() body: ReverseCreditsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ReverseCreditsResultDto> {
    const admin = adminOf(request);
    const { lotIds } = await this.ledger.reverse({
      workspaceId: body.workspaceId,
      jobId: body.jobId,
      tenths: body.tenths,
      reason: body.reason,
    });
    await this.audit.record({
      action: "admin.credits.reversed",
      resource: "job",
      resourceId: body.jobId,
      workspaceId: body.workspaceId,
      actorId: admin.userId,
      actorKind: "admin",
      ...(admin.ip === undefined ? {} : { ip: admin.ip }),
      data: { tenths: body.tenths, reason: body.reason, lotIds },
    });
    return { lotIds: [...lotIds] };
  }

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
