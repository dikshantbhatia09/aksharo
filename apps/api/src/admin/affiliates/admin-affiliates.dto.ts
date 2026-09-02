import { ApiProperty } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const Form16aQueryBody = z.object({
  fy: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, "FYYYYY-YY, e.g. 2026-27"),
  draft: z.coerce.boolean().default(true),
});
export class Form16aQueryDto extends zodDto(Form16aQueryBody) {}

export class AdminPendingAffiliateDto {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() status!: string;
  @ApiProperty() country!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
}
