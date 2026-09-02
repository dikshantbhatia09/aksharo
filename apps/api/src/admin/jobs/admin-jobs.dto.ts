import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";

const ListJobsQueryBody = z.object({
  queue: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
  workspaceId: z.string().length(26).optional(),
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export class AdminListJobsQueryDto extends zodDto(ListJobsQueryBody) {}

export class AdminJobSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty() workspaceId!: string;
  @ApiProperty() type!: string;
  @ApiProperty() status!: string;
  @ApiProperty() attemptNo!: number;
  @ApiPropertyOptional() error?: unknown;
  @ApiProperty({ format: "date-time" }) queuedAt!: string;
  @ApiPropertyOptional({ format: "date-time" }) startedAt?: string | null;
  @ApiPropertyOptional({ format: "date-time" }) finishedAt?: string | null;
}

export class AdminQueueStatsDto {
  @ApiProperty() queue!: string;
  @ApiProperty() queued!: number;
  @ApiProperty() running!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() succeeded!: number;
  @ApiProperty() cancelled!: number;
}
