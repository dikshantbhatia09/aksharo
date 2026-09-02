import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../common/validation/zod-validation.pipe.js";

import type { CreditsSummaryView, UsageEntryView, UsagePage } from "./credits-query.service.js";

const LOT_SOURCES = ["grant", "topup", "pass", "referral", "adjust", "reversal"] as const;
const LEDGER_KINDS = [
  "grant",
  "purchase",
  "hold",
  "settle",
  "release",
  "reversal",
  "refund",
  "adjust",
  "expire",
  "referral_bonus",
] as const;

const ListUsageQuery = z.object({
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
export class ListUsageQueryDto extends zodDto(ListUsageQuery) {}

export class LotDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: LOT_SOURCES }) source!: string;
  @ApiProperty() grantedTenths!: number;
  @ApiProperty() remainingTenths!: number;
  @ApiPropertyOptional({ nullable: true, format: "date-time" }) expiresAt!: string | null;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}

export class CreditsSummaryDto {
  @ApiProperty() workspaceId!: string;
  @ApiProperty({ description: "Cached balance in tenths of a credit (CONTRACTS §0)." })
  balanceTenths!: number;
  @ApiProperty() monthlyGrantTenths!: number;
  @ApiPropertyOptional({ nullable: true, format: "date-time" }) grantResetAt!: string | null;
  @ApiProperty({ type: [LotDto], description: "Live lots, soonest-expiring first then FIFO." })
  lots!: LotDto[];
}

export class UsageEntryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ description: "Positive credits a workspace, negative credits spent." })
  deltaTenths!: number;
  @ApiProperty({ enum: LEDGER_KINDS }) kind!: string;
  @ApiProperty() refType!: string;
  @ApiPropertyOptional({ nullable: true }) refId!: string | null;
  @ApiPropertyOptional({ nullable: true }) lotId!: string | null;
  @ApiProperty() balanceAfterTenths!: number;
  @ApiProperty({ format: "date-time" }) at!: string;
  @ApiPropertyOptional({ nullable: true, description: 'The job\'s queue, when refType is "job".' })
  jobType!: string | null;
}

export class UsagePageDto {
  @ApiProperty({ type: [UsageEntryDto] }) items!: UsageEntryDto[];
  @ApiPropertyOptional({ nullable: true }) nextCursor!: string | null;
}

export function toCreditsSummaryDto(view: CreditsSummaryView): CreditsSummaryDto {
  return { ...view, lots: [...view.lots] };
}

export function toUsageEntryDto(view: UsageEntryView): UsageEntryDto {
  return { ...view };
}

export function toUsagePageDto(page: UsagePage): UsagePageDto {
  return { items: page.items.map(toUsageEntryDto), nextCursor: page.nextCursor };
}
