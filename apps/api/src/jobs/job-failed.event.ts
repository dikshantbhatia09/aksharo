/**
 * Event name and payload `JobsService.complete()` emits once a job's status
 * has actually flipped to `failed` and dead-letter handling has run (B14b:
 * "job.failed from jobs.service when a job reaches failed, after DLQ
 * handling"), the same `EventEmitter2` precedent as
 * `referrals/export-completed.event.ts`.
 */
export const JOB_FAILED_EVENT = "job.failed";

export interface JobFailedPayload {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly jobType: string;
  readonly projectId: string | null;
  readonly error: { readonly code?: string; readonly message?: string } | null;
}
