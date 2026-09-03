import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const ResolveReportBody = z.object({
  action: z.enum(["take_down", "dismiss", "warned"]),
  note: z.string().trim().min(10).max(500),
});
export class ResolveReportDto extends zodDto(ResolveReportBody) {}

export class ShareReportSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() shareLinkId!: string;
  @ApiProperty() category!: string;
  @ApiProperty({ format: "date-time" }) receivedAt!: string;
  @ApiProperty({ format: "date-time" }) dueAt!: string;
}
