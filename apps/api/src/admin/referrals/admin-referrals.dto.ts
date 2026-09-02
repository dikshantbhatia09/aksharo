import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const RejectHoldBody = z.object({
  reason: z.string().trim().min(10).max(500),
});
export class RejectHoldDto extends zodDto(RejectHoldBody) {}

export class HeldReferralDto {
  @ApiProperty() id!: string;
  @ApiProperty() referrerWorkspaceId!: string;
  @ApiProperty() referredWorkspaceId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() holdReason!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
