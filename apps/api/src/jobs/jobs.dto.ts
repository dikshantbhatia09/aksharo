import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { z } from "zod";

import { QUEUE_NAMES } from "./contracts/queue-names.js";
import { JOBS_MAX_PAGE_SIZE, JOBS_PAGE_SIZE } from "./jobs.config.js";
import { zodDto } from "../common/validation/zod-validation.pipe.js";

import type { Job } from "@prisma/client";

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

const ListJobsQuery = z.object({
  projectId: z.string().length(26).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(QUEUE_NAMES).optional(),
  /** Id of the last item on the previous page. */
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(JOBS_MAX_PAGE_SIZE).optional(),
});

export class ListJobsQueryDto extends zodDto(ListJobsQuery) {}

const ListEventsQuery = z.object({
  cursor: z.string().length(26).optional(),
  limit: z.coerce.number().int().min(1).max(JOBS_MAX_PAGE_SIZE).optional(),
});

export class ListEventsQueryDto extends zodDto(ListEventsQuery) {}

/** One job, as the API returns it. */
export class JobDto {
  @ApiProperty({ example: "01JBZ0Q4T7R8N4H1V0J9K2M3P5", description: "ULID." })
  id!: string;

  @ApiProperty({ enum: QUEUE_NAMES, description: "Queue name (CONTRACTS §3)." })
  type!: string;

  @ApiProperty({ enum: JOB_STATUSES })
  status!: string;

  @ApiProperty({ description: "Lower runs first; derived from the workspace's plan." })
  priority!: number;

  @ApiProperty({ description: "0–100." })
  progress!: number;

  @ApiPropertyOptional({ nullable: true, description: "Estimated milliseconds remaining." })
  etaMs!: number | null;

  @ApiPropertyOptional({ nullable: true })
  projectId!: string | null;

  @ApiProperty({ description: "Deduplication key: one live job per (workspace, key)." })
  jobKey!: string;

  @ApiPropertyOptional({ nullable: true, description: "Identifies this run of the job." })
  attemptId!: string | null;

  @ApiProperty({
    description: "Credits in tenths: the hold while running, the charge once finished.",
  })
  creditsChargedTenths!: number;

  @ApiPropertyOptional({
    nullable: true,
    description: "Milliseconds this job may wait in `queued`.",
  })
  maxQueueWaitMs!: number | null;

  @ApiPropertyOptional({ nullable: true, type: Object, description: "Completion result." })
  result!: unknown;

  @ApiPropertyOptional({
    nullable: true,
    type: Object,
    description: "`{code, message, retryable}`.",
  })
  error!: unknown;

  @ApiPropertyOptional({ nullable: true })
  provider!: string | null;

  @ApiPropertyOptional({ nullable: true })
  model!: string | null;

  @ApiProperty({ format: "date-time" })
  queuedAt!: string;

  @ApiPropertyOptional({ nullable: true, format: "date-time" })
  startedAt!: string | null;

  @ApiPropertyOptional({ nullable: true, format: "date-time" })
  finishedAt!: string | null;
}

export class JobPageDto {
  @ApiProperty({ type: [JobDto] })
  items!: JobDto[];

  @ApiPropertyOptional({ nullable: true, description: "Pass as `cursor` for the next page." })
  nextCursor!: string | null;
}

export class JobEventDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: "date-time" }) at!: string;
  @ApiProperty({ enum: ["debug", "info", "warn", "error"] }) level!: string;
  @ApiProperty() message!: string;
  @ApiPropertyOptional({ type: Object, nullable: true }) data!: unknown;
}

export class JobEventPageDto {
  @ApiProperty({ type: [JobEventDto] })
  items!: JobEventDto[];

  @ApiPropertyOptional({ nullable: true })
  nextCursor!: string | null;
}

/**
 * Prisma row → wire shape.
 *
 * Three things happen here and nowhere else: `Date` becomes ISO-8601 (CONTRACTS
 * §0), `BigInt` becomes a number (`JSON.stringify` throws on a BigInt), and
 * `creditHoldId` is dropped — a hold id is an internal credit-ledger handle and no
 * client has any use for it.
 */
export function toJobDto(job: Job): JobDto {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    priority: job.priority,
    progress: job.progress,
    etaMs: job.etaMs,
    projectId: job.projectId,
    jobKey: job.jobKey,
    attemptId: job.attemptId,
    creditsChargedTenths: job.creditsChargedTenths,
    maxQueueWaitMs: job.maxQueueWaitMs,
    result: job.result ?? null,
    error: job.error ?? null,
    provider: job.provider,
    model: job.model,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export interface JobEventRow {
  readonly id: string;
  readonly at: Date;
  readonly level: string;
  readonly message: string;
  readonly data: unknown;
}

export function toJobEventDto(event: JobEventRow): JobEventDto {
  return {
    id: event.id,
    at: event.at.toISOString(),
    level: event.level,
    message: event.message,
    data: event.data ?? null,
  };
}

/** Default page size, exported so the OpenAPI description and the code agree. */
export const DEFAULT_PAGE_SIZE = JOBS_PAGE_SIZE;
