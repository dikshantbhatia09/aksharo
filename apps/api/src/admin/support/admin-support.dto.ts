import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";
import { SUPPORT_CATEGORIES, SUPPORT_STATUSES } from "../../support/support.dto.js";

const ListSupportTicketsQuery = z.object({
  status: z.enum(SUPPORT_STATUSES).optional(),
  category: z.enum(SUPPORT_CATEGORIES).optional(),
});
export class ListSupportTicketsQueryDto extends zodDto(ListSupportTicketsQuery) {}

const SetTicketStatusBody = z.object({
  status: z.enum(SUPPORT_STATUSES),
});
export class SetTicketStatusDto extends zodDto(SetTicketStatusBody) {}

const ReplyToTicketBody = z.object({
  body: z.string().trim().min(1).max(5_000),
});
export class ReplyToTicketDto extends zodDto(ReplyToTicketBody) {}

export class AdminSupportTicketDto {
  @ApiProperty() id!: string;
  @ApiProperty() workspaceId!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() subject!: string;
  @ApiProperty() body!: string;
  @ApiProperty() category!: string;
  @ApiProperty() status!: string;
  @ApiProperty() hasDiagnostics!: boolean;
  @ApiPropertyOptional({ nullable: true }) diagnostics!: unknown;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiProperty({ format: "date-time" }) updatedAt!: string;
}
