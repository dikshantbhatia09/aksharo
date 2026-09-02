import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

/**
 * Reason codes for an admin refund. Free text (`reason`) is still mandatory
 * on top — the code is what a report groups by, the text is what a human
 * reads (B13 scope §1: "mandatory free-text reason for money/credit actions").
 */
export const REFUND_REASON_CODES = [
  "customer_request",
  "quality_issue",
  "duplicate_charge",
  "billing_error",
  "goodwill",
  "other",
] as const;

const AdminRefundBody = z.object({
  providerPaymentId: z.string().trim().min(1).max(64),
  reasonCode: z.enum(REFUND_REASON_CODES),
  reason: z.string().trim().min(10).max(500),
  /**
   * Override the lot's recorded `amountMinor` (rare: a lot with no payment
   * amount on file, or a partial provider-side capture). Omit to let the
   * policy work off `credit_lots.amount_minor`.
   */
  amountMinorOverride: z.number().int().positive().optional(),
});
export class AdminRefundDto extends zodDto(AdminRefundBody) {}

export class AdminRefundResultDto {
  @ApiProperty() outcome!: string;
  @ApiProperty() providerRefundId!: string;
  @ApiProperty({ enum: ["full", "pro_rata"] }) policy!: string;
  @ApiProperty() requestedAmountMinor!: number;
  @ApiProperty() refundAmountMinor!: number;
  @ApiPropertyOptional() creditNoteId?: string;
  @ApiPropertyOptional() creditNoteNumber?: string;
  @ApiPropertyOptional({
    description:
      "Set when no original tax invoice was found for this purchase — no credit note was issued.",
  })
  creditNoteSkippedReason?: string;
}

// ---------------------------------------------------------------------------
// Mandate/dunning monitor (B13 scope §2, read-only)
// ---------------------------------------------------------------------------

export class AdminDunningEntryDto {
  @ApiProperty() subscriptionId!: string;
  @ApiProperty() workspaceId!: string;
  @ApiProperty() status!: string;
  @ApiPropertyOptional({ format: "date-time" }) graceUntil?: string | null;
  @ApiPropertyOptional({ format: "date-time" }) renewalInitiateAt?: string | null;
  @ApiPropertyOptional() mandateStatus?: string | null;
  @ApiPropertyOptional() mandateMethod?: string | null;
}
