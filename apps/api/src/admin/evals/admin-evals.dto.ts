import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const FreezeBody = z.object({
  reason: z.string().trim().min(1).max(500),
});
export class FreezeRoutingDto extends zodDto(FreezeBody) {}

export class LeaderboardRowDto {
  @ApiProperty() dataset!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() language!: string;
  @ApiPropertyOptional() provider?: string;
  @ApiProperty() metricName!: string;
  @ApiProperty() metricValue!: number;
  @ApiPropertyOptional() previousMetricValue?: number;
  @ApiPropertyOptional() trend?: number;
  @ApiProperty() itemCount!: number;
  @ApiProperty() runId!: string;
  @ApiProperty() measuredAt!: string;
}

export class RoutingFreezeStateDto {
  @ApiProperty() frozen!: boolean;
  @ApiPropertyOptional() reason?: string;
  @ApiPropertyOptional() updatedBy?: string;
  @ApiProperty() updatedAt!: string;
}
