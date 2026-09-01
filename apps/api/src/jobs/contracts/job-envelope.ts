import { z } from "zod";

/**
 * The job envelope of `docs/CONTRACTS.md` §3 — every job's BullMQ `data`, on every
 * queue:
 *
 * ```
 * { jobId, attemptId, workspaceId, projectId?, priority, jobKey, createdAt, payload }
 * ```
 *
 * A consumer in another language parses this, so the rules are strict:
 * - every id is a string (`apps/worker-ai` rejects a non-string outright);
 * - `projectId` is **omitted**, never `null`, when the job has no project;
 * - `createdAt` is ISO-8601 UTC;
 * - `payload` is an object, and its shape belongs to the job type's owner
 *   (A07 media, A09/A11 ai, A20 render), not to A08.
 */
export interface JobEnvelope<TPayload = Record<string, unknown>> {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly projectId?: string;
  readonly priority: number;
  /** Deduplication key: the same key must never run twice concurrently. */
  readonly jobKey: string;
  /** ISO-8601. */
  readonly createdAt: string;
  readonly payload: TPayload;
}

/** Runtime shape of {@link JobEnvelope}. */
export const JobEnvelopeSchema = z.object({
  jobId: z.string().min(1),
  attemptId: z.string().min(1),
  workspaceId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  priority: z.number().int().min(0),
  jobKey: z.string().min(1),
  createdAt: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export interface BuildEnvelopeInput {
  readonly jobId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly projectId?: string | null;
  readonly priority: number;
  readonly jobKey: string;
  readonly createdAt: Date;
  readonly payload: Record<string, unknown>;
}

/**
 * Build the envelope for one job.
 *
 * `projectId` is spread in only when present: `JSON.stringify` drops `undefined`
 * but keeps `null`, and a `null` there would fail the Python worker's contract
 * check on a job that is otherwise perfectly valid.
 */
export function buildJobEnvelope(input: BuildEnvelopeInput): JobEnvelope {
  return {
    jobId: input.jobId,
    attemptId: input.attemptId,
    workspaceId: input.workspaceId,
    ...(input.projectId === undefined || input.projectId === null
      ? {}
      : { projectId: input.projectId }),
    priority: input.priority,
    jobKey: input.jobKey,
    createdAt: input.createdAt.toISOString(),
    payload: input.payload,
  };
}

/** Narrow an unknown BullMQ `job.data` to the contract envelope. */
export function isJobEnvelope(value: unknown): value is JobEnvelope {
  return JobEnvelopeSchema.safeParse(value).success;
}
