"use client";

/**
 * FIX-03: the client half of the transcription read model, plus the single DOM
 * event that stitches push delivery to whatever screen is currently mounted.
 * `defineEndpoint` is `@montaj/api-client`'s documented escape hatch for a route
 * the curated hooks don't cover (same pattern as `use-timeline-media.ts`).
 */
import type { ApiClient } from "@montaj/api-client";
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

/** 4 s -> 8 s -> 15 s, then 15 s for as long as anything is genuinely waiting. */
export const TRANSCRIPTION_POLL_BACKOFF_MS = [4_000, 8_000, 15_000] as const;

/** The states that are still moving — the only ones worth another request. */
export const TRANSCRIPTION_WAITING_STATUSES: ReadonlySet<TranscriptionStateView["status"]> = new Set(
  ["queued", "running", "processing_media"],
);

/**
 * Poll this read model until it leaves {@link TRANSCRIPTION_WAITING_STATUSES} —
 * i.e. until a job settles, one way or the other.
 *
 * `announceTranscriptReady` above is the push half (`AppShell`'s realtime
 * listener calls it on a `job.completed` frame); this is the fallback half, for
 * a caller with no waiting screen to fall back to poll from. `needs-
 * transcription.tsx` only ever mounts while a project has never had a
 * document — a re-transcription of one that already does replaces the
 * document *in place*, so the editor stays mounted and push is the only thing
 * that was ever watching. `RetranscribeDialog` is that caller.
 */
export function pollTranscriptionState(
  client: ApiClient,
  projectId: string,
  onTick: (view: TranscriptionStateView) => void,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  async function tick(): Promise<void> {
    let settled = false;
    try {
      const next = await client.call(getTranscriptionState, { params: { projectId } });
      if (cancelled) return;
      onTick(next);
      settled = !TRANSCRIPTION_WAITING_STATUSES.has(next.status);
    } catch {
      // A transient failure must not strand the poll on a stale answer — keep
      // the rhythm and try again on the next tick.
      if (cancelled) return;
    }
    if (settled) return;
    const delay =
      TRANSCRIPTION_POLL_BACKOFF_MS[Math.min(attempt, TRANSCRIPTION_POLL_BACKOFF_MS.length - 1)] ??
      15_000;
    attempt += 1;
    timer = setTimeout(() => void tick(), delay);
  }

  void tick();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
