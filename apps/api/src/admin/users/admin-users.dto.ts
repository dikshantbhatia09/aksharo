import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const AdminSearchQueryBody = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export class AdminSearchQueryDto extends zodDto(AdminSearchQueryBody) {}

export class AdminUserSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiPropertyOptional() name?: string | null;
  @ApiProperty() isAdmin!: boolean;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiPropertyOptional({ format: "date-time" }) lastSeenAt?: string | null;
  @ApiPropertyOptional({ format: "date-time" }) deletedAt?: string | null;
}

export class AdminMembershipDto {
  @ApiProperty() workspaceId!: string;
  @ApiProperty() workspaceName!: string;
  @ApiProperty() role!: string;
  @ApiProperty() status!: string;
}

export class AdminUserDetailDto extends AdminUserSummaryDto {
  @ApiProperty({ type: [AdminMembershipDto] }) memberships!: AdminMembershipDto[];
  @ApiProperty() deviceCount!: number;
  @ApiProperty() adminRoles!: string[];
}

export class AdminWorkspaceSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() name!: string;
  @ApiProperty() type!: string;
  @ApiProperty() ownerId!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiPropertyOptional({ format: "date-time" }) deletedAt?: string | null;
}

export class AdminCreditAccountDto {
  @ApiProperty() balanceTenths!: number;
  @ApiProperty() monthlyGrantTenths!: number;
  @ApiPropertyOptional({ format: "date-time" }) grantResetAt?: string | null;
  @ApiProperty() negativeAllowed!: boolean;
}

export class AdminSubscriptionDto {
  @ApiProperty() planId!: string;
  @ApiProperty() status!: string;
  @ApiProperty() currency!: string;
  @ApiProperty({ format: "date-time" }) currentPeriodEnd!: string;
  @ApiProperty() cancelAtPeriodEnd!: boolean;
}

export class AdminWorkspaceDetailDto extends AdminWorkspaceSummaryDto {
  @ApiPropertyOptional() ownerEmail?: string;
  @ApiProperty() memberCount!: number;
  @ApiPropertyOptional({ type: AdminCreditAccountDto }) creditAccount?: AdminCreditAccountDto;
  @ApiPropertyOptional({ type: AdminSubscriptionDto }) subscription?: AdminSubscriptionDto;
}
