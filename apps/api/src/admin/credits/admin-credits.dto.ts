import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

import type {
  OrphanedHold,
  OrphanedHoldResolution,
} from "../../credits/credit-orphaned-holds.service.js";
import type { AccountReconciliation } from "../../credits/credit-reconcile.service.js";

const ResolveOrphanedHoldsBody = z.object({
  holdIds: z.array(z.string().length(26)).min(1).max(100).optional(),
  /** Report what would happen and change nothing. Defaults to **true**. */
  dryRun: z.boolean().default(true),
});
export class ResolveOrphanedHoldsDto extends zodDto(ResolveOrphanedHoldsBody) {}

export class OrphanedHoldDto {
  @ApiProperty() holdId!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty() workspaceId!: string;
  @ApiProperty() queue!: string;
  @ApiProperty() jobStatus!: string;
  @ApiProperty() amountTenths!: number;
  @ApiProperty({ format: "date-time" }) heldSince!: string;
}

export class OrphanedHoldResolutionDto {
  @ApiProperty() holdId!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty() queue!: string;

  @ApiProperty({ enum: ["released", "settled", "would_release", "would_settle", "failed"] })
  action!: string;

  @ApiPropertyOptional() error?: string;
}

export class AccountReconciliationDto {
  @ApiProperty() accountId!: string;
  @ApiProperty() workspaceId!: string;
  @ApiProperty() balanceTenths!: number;
  @ApiProperty() lotsSumTenths!: number;
  @ApiProperty() ledgerSumTenths!: number;
  @ApiProperty() ok!: boolean;
  @ApiProperty() lotsDriftTenths!: number;
  @ApiProperty() ledgerDriftTenths!: number;
}

export function toOrphanedHoldDto(hold: OrphanedHold): OrphanedHoldDto {
  return { ...hold };
}

export function toOrphanedHoldResolutionDto(
  resolution: OrphanedHoldResolution,
): OrphanedHoldResolutionDto {
  return { ...resolution };
}

export function toAccountReconciliationDto(
  reconciliation: AccountReconciliation,
): AccountReconciliationDto {
  return { ...reconciliation };
}

// ---------------------------------------------------------------------------
// B13b — admin adjust / reverse (finance/superadmin only, mandatory reason)
// ---------------------------------------------------------------------------

const AdjustCreditsBody = z.object({
  workspaceId: z.string().length(26),
  /** Tenths of a credit (CONTRACTS §0). Positive only — this is a grant, not a debit. */
  tenths: z.number().int().positive(),
  /** Mandatory free-text reason: every money/credit action is reason-required (B13 scope §1). */
  reason: z.string().trim().min(10).max(500),
});
export class AdjustCreditsDto extends zodDto(AdjustCreditsBody) {}

export class AdjustCreditsResultDto {
  @ApiProperty() lotId!: string;
}

const ReverseCreditsBody = z.object({
  workspaceId: z.string().length(26),
  jobId: z.string().length(26),
  tenths: z.number().int().positive(),
  reason: z.string().trim().min(10).max(500),
});
export class ReverseCreditsDto extends zodDto(ReverseCreditsBody) {}

export class ReverseCreditsResultDto {
  @ApiProperty({ type: [String] }) lotIds!: string[];
}
