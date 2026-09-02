import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { zodDto } from "../../common/validation/zod-validation.pipe.js";
import { QUEUE_NAMES } from "../../jobs/contracts/queue-names.js";
import { DLQ_MAX_BULK, JOBS_MAX_PAGE_SIZE } from "../../jobs/jobs.config.js";

import type { DlqEntry } from "@prisma/client";

export const DLQ_STATUSES = ["pending", "replayed", "discarded"] as const;

/** An ISO-8601 instant or anything `Date` can parse; rejected if it is neither. */
const IsoDate = z
  .string()
  .min(4)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "not a date" })
  .transform((value) => new Date(value));

const ListDlqQuery = z.object({
  queue: z.enum(QUEUE_NAMES).optional(),
  status: z.enum(DLQ_STATUSES).optional(),
  workspaceId: z.string().length(26).optional(),
  /** Substring of the last error's `code` or `message`. */
  reason: z.string().min(1).max(200).optional(),
  since: IsoDate.optional(),
  until: IsoDate.optional(),
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(JOBS_MAX_PAGE_SIZE).optional(),
});

export class ListDlqQueryDto extends zodDto(ListDlqQuery) {}

const DiscardBody = z.object({
  /** Mandatory: the DLQ is also the record of what the system could not do. */
  reason: z.string().min(1).max(500),
});

export class DiscardDlqDto extends zodDto(DiscardBody) {}

const BulkBody = z.object({
  /** Entry ids or job ids. When present, the filter fields are ignored. */
  ids: z.array(z.string().length(26)).min(1).max(DLQ_MAX_BULK).optional(),
  queue: z.enum(QUEUE_NAMES).optional(),
  workspaceId: z.string().length(26).optional(),
  reason: z.string().min(1).max(200).optional(),
  since: IsoDate.optional(),
  until: IsoDate.optional(),
  limit: z.coerce.number().int().min(1).max(DLQ_MAX_BULK).optional(),
  /** Report what would happen and change nothing. Defaults to **true**. */
  dryRun: z.boolean().default(true),
});

const BulkReplayBody = BulkBody;
export class BulkReplayDlqDto extends zodDto(BulkReplayBody) {}

const BulkDiscardBody = BulkBody.extend({
  /** Recorded on every row the operation discards. */
  discardReason: z.string().min(1).max(500),
});
export class BulkDiscardDlqDto extends zodDto(BulkDiscardBody) {}

export class DlqEntryDto {
  @ApiProperty({ description: "ULID of the dead-letter entry." }) id!: string;
  @ApiProperty({ description: "The job that failed." }) jobId!: string;
  @ApiProperty() workspaceId!: string;
  @ApiPropertyOptional({ nullable: true }) projectId!: string | null;
  @ApiProperty({ enum: QUEUE_NAMES }) queue!: string;
  @ApiProperty({ description: "Deduplication key of the failed job." }) jobKey!: string;
  @ApiProperty({ description: "The attempt that gave up." }) attemptId!: string;
  @ApiProperty({ description: "1-based ordinal of that attempt." }) attemptNo!: number;
  @ApiProperty({ description: "Attempts made in total." }) attempts!: number;

  @ApiPropertyOptional({ type: Object, nullable: true, description: "The queue payload." })
  payload!: unknown;

  @ApiPropertyOptional({
    type: Object,
    nullable: true,
    description: "`{code, message, retryable}` of the final attempt.",
  })
  lastError!: unknown;

  @ApiProperty({ description: "Credits held in tenths; a replay reserves this again." })
  worstCaseTenths!: number;

  @ApiProperty({ format: "date-time" }) failedAt!: string;
  @ApiProperty({ enum: DLQ_STATUSES }) status!: string;
  @ApiPropertyOptional({ nullable: true }) resolvedBy!: string | null;
  @ApiPropertyOptional({ nullable: true, format: "date-time" }) resolvedAt!: string | null;
  @ApiPropertyOptional({ nullable: true }) resolution!: string | null;
}

export class DlqPageDto {
  @ApiProperty({ type: [DlqEntryDto] }) items!: DlqEntryDto[];
  @ApiPropertyOptional({ nullable: true }) nextCursor!: string | null;
}

export class DlqQueueStatsDto {
  @ApiProperty({ enum: QUEUE_NAMES }) queue!: string;
  @ApiProperty() pending!: number;
  @ApiProperty() replayed!: number;
  @ApiProperty() discarded!: number;
  @ApiPropertyOptional({ nullable: true, format: "date-time" }) oldestFailedAt!: string | null;
  @ApiPropertyOptional({ nullable: true, format: "date-time" }) newestFailedAt!: string | null;

  @ApiProperty({ description: "Distinct error codes among the pending rows." })
  distinctErrors!: number;
}

export class DlqStatsDto {
  @ApiProperty({ type: [DlqQueueStatsDto] }) queues!: DlqQueueStatsDto[];
  @ApiProperty({ description: "Pending entries across every queue." }) pending!: number;
}

export class ReplayResultDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty({ description: "The ULID minted for the replay." }) attemptId!: string;
  @ApiProperty({ description: "1-based: three failures then a replay is 4." }) attemptNo!: number;
  @ApiProperty({ enum: QUEUE_NAMES }) queue!: string;
}

export class DiscardResultDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty({ enum: QUEUE_NAMES }) queue!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ description: "Whether a credit hold was actually released." })
  holdReleased!: boolean;
}

export class BulkEntryOutcomeDto {
  @ApiProperty() entryId!: string;
  @ApiProperty() jobId!: string;
  @ApiProperty() queue!: string;

  @ApiProperty({ enum: ["replayed", "discarded", "would_replay", "would_discard", "failed"] })
  outcome!: string;

  @ApiPropertyOptional() error?: string;
}

export class BulkOutcomeDto {
  @ApiProperty({ description: "Entries the filter selected." }) selected!: number;
  @ApiProperty() replayed!: number;
  @ApiProperty() discarded!: number;
  @ApiProperty() failed!: number;
  @ApiProperty({ description: "Nothing changed; the counts are a projection." })
  dryRun!: boolean;

  @ApiProperty({ type: [BulkEntryOutcomeDto] }) entries!: BulkEntryOutcomeDto[];
}

/** Prisma row to wire shape: `Date` becomes ISO-8601 (CONTRACTS section 0). */
export function toDlqEntryDto(entry: DlqEntry): DlqEntryDto {
  return {
    id: entry.id,
    jobId: entry.jobId,
    workspaceId: entry.workspaceId,
    projectId: entry.projectId,
    queue: entry.queue,
    jobKey: entry.jobKey,
    attemptId: entry.attemptId,
    attemptNo: entry.attemptNo,
    attempts: entry.attempts,
    payload: entry.payload ?? null,
    lastError: entry.lastError ?? null,
    worstCaseTenths: entry.worstCaseTenths,
    failedAt: entry.failedAt.toISOString(),
    status: entry.status,
    resolvedBy: entry.resolvedBy,
    resolvedAt: entry.resolvedAt?.toISOString() ?? null,
    resolution: entry.resolution,
  };
}
