/**
 * Event name and payload `transcribe.handler.ts` emits right after it commits
 * a completed transcription (B14b: "each becomes a named `EventEmitter2`
 * event at its source, the same precedent as
 * `referrals/export-completed.event.ts`").
 *
 * `EventEmitter2` (`EventEmitterModule.forRoot()`, registered once in
 * `app.module.ts`) is global, so `webhooks/listeners/transcript-completed.listener.ts`
 * picks this up without either module importing the other's internals.
 */
export const TRANSCRIPT_COMPLETED_EVENT = "transcript.completed";

export interface TranscriptCompletedPayload {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly transcriptId: string;
  readonly jobId: string;
}
