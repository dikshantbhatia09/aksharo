import { z } from "zod";

/**
 * Bodies of the worker → API callbacks of `docs/CONTRACTS.md` §3.
 *
 * `POST /internal/jobs/{jobId}/complete`
 *   `{ status, result?, error?, usage? }`
 * `POST /internal/jobs/{jobId}/progress`
 *   `{ progress, etaMs, message }`
 *
 * Both are signed (see `src/internal/internal-signature.ts`) and both are
 * at-least-once: a worker that does not see a 2xx retries, so every handler here
 * is idempotent on `(jobId, attemptId)`.
 */

/**
 * What the job actually consumed. `settle` is called with the credit cost derived
 * from this, so a worker that reports nothing settles the full hold.
 */
export const JobUsageSchema = z.object({
  /** Input media duration in seconds. */
  mediaSeconds: z.number().min(0).optional(),
  /** Rendered output duration in seconds. */
  outputSeconds: z.number().min(0).optional(),
  provider: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(128).optional(),
  /** Vendor cost in minor units of the vendor's currency — margin analysis only. */
  costMinor: z.number().int().min(0).optional(),
  egressBytes: z.number().int().min(0).optional(),
  /**
   * Credits actually consumed, in tenths. When a worker knows the exact figure it
   * says so; otherwise the API settles the full hold.
   */
  actualTenths: z.number().int().min(0).optional(),
});

export type JobUsage = z.infer<typeof JobUsageSchema>;

/** `jobs.error` — the Zod schema the schema comment on that column refers to. */
export const JobErrorSchema = z.object({
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2_000),
  /** `false` sends the job straight to the dead-letter path (A08b). */
  retryable: z.boolean().default(true),
});

export type JobError = z.infer<typeof JobErrorSchema>;

export const JobCompletionSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: JobErrorSchema.optional(),
  usage: JobUsageSchema.optional(),
  /** Set by BullMQ-side retry exhaustion; A08b reads it to fill the DLQ table. */
  finalAttempt: z.boolean().optional(),
});

export type JobCompletion = z.infer<typeof JobCompletionSchema>;

export const JobProgressSchema = z.object({
  /** Percent complete, 0–100. */
  progress: z.number().min(0).max(100),
  etaMs: z.number().int().min(0).optional(),
  message: z.string().max(1_000).optional(),
});

export type JobProgress = z.infer<typeof JobProgressSchema>;

/**
 * Body of `POST /internal/jobs/{jobId}/enqueue-child`: a follow-up a worker asks
 * for, such as `media.probe` discovering that a proxy is needed.
 */
export const EnqueueChildSchema = z.object({
  type: z.string().min(1).max(64),
  payload: z.record(z.string(), z.unknown()).default({}),
  /** Worst-case hold in tenths; defaults to 0 (free follow-up). */
  worstCaseTenths: z.number().int().min(0).default(0),
  /** Defaults to `{parentJobKey}:{type}` so a retried parent cannot fan out twice. */
  jobKey: z.string().min(1).max(200).optional(),
  reason: z.string().min(1).max(200).optional(),
});

export type EnqueueChild = z.infer<typeof EnqueueChildSchema>;

/** Reply shape shared by both callbacks, so a worker can log one thing. */
export interface CallbackAck {
  /** `false` when the call was a replay or a stale attempt and changed nothing. */
  readonly applied: boolean;
  readonly jobId: string;
  readonly status: string;
  /** Present when `applied` is false: `already_completed`, `stale_attempt`, ... */
  readonly reason?: string;
}
