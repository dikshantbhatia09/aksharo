"use client";

/**
 * FIX-03: the client half of the transcription read model, plus the single DOM
 * event that stitches push delivery to whatever screen is currently mounted.
 * `defineEndpoint` is `@montaj/api-client`'s documented escape hatch for a route
 * the curated hooks don't cover (same pattern as `use-timeline-media.ts`).
 */
import { defineEndpoint } from "@montaj/api-client";

export interface TranscriptionStateView {
  readonly status:
    | "ready"
    | "queued"
    | "running"
    | "failed"
    | "not_started"
    | "awaiting_language"
    | "processing_media"
    | "no_media";
  readonly jobId?: string;
  readonly error?: string;
}

export const getTranscriptionState = defineEndpoint<void, TranscriptionStateView>({
  method: "GET",
  path: "/projects/{projectId}/transcription-state",
  auth: "bearer",
});

export const TRANSCRIPT_READY_EVENT = "montaj:transcript-ready";

export function announceTranscriptReady(projectId: string): void {
  window.dispatchEvent(new CustomEvent(TRANSCRIPT_READY_EVENT, { detail: { projectId } }));
}

export function onTranscriptReady(projectId: string, handler: () => void): () => void {
  const listener = (event: Event): void => {
    if ((event as CustomEvent<{ projectId?: string }>).detail?.projectId === projectId) handler();
  };
  window.addEventListener(TRANSCRIPT_READY_EVENT, listener);
  return () => window.removeEventListener(TRANSCRIPT_READY_EVENT, listener);
}
