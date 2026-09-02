"use client";

/**
 * Realtime progress for a running pass job (`ai.pass`), for the Passes tab's
 * "progress while running" requirement (B20 §1).
 *
 * A dedicated `RealtimeClient` connection, not a reuse of `use-editor-store
 * .ts`'s `useEdgRealtime` socket — that hook does not expose its connection,
 * and a second socket subscribed to the same `rooms.project(projectId)` room
 * costs one extra connection for the lifetime of the Passes tab being open,
 * which is a fair trade against coupling this file to the transcript
 * editor's internals. Reported as a minor inefficiency in the final report,
 * not a correctness issue — `08 §2` puts no limit on room subscriptions per
 * client.
 */
import * as React from "react";

import { RealtimeClient, rooms, useApiContext } from "@montaj/api-client";

export interface PassRunProgress {
  readonly jobId: string;
  readonly ratio: number | undefined;
  readonly etaMs: number | undefined;
  readonly message: string | undefined;
  readonly status: "running" | "completed" | "failed";
  readonly error: string | undefined;
}

/** Tracks one `ai.pass` job's `job.progress`/`job.completed` events. `jobId === null` subscribes to nothing. */
export function usePassRunProgress(projectId: string, jobId: string | null): PassRunProgress | null {
  const { client, session } = useApiContext();
  const [progress, setProgress] = React.useState<PassRunProgress | null>(null);

  React.useEffect(() => {
    setProgress(jobId === null ? null : { jobId, ratio: undefined, etaMs: undefined, message: undefined, status: "running", error: undefined });
    if (jobId === null) return;

    const realtime = new RealtimeClient({
      url: client.realtimeUrl,
      getAccessToken: () => session.getAccessToken(),
    });
    realtime.subscribe(rooms.project(projectId));

    const unsubProgress = realtime.on("job.progress", (event) => {
      const data = event.data as { jobId?: unknown; progress?: unknown; etaMs?: unknown; message?: unknown };
      if (data.jobId !== jobId) return;
      setProgress((prev) => ({
        jobId,
        ratio: typeof data.progress === "number" ? data.progress : prev?.ratio,
        etaMs: typeof data.etaMs === "number" ? data.etaMs : prev?.etaMs,
        message: typeof data.message === "string" ? data.message : prev?.message,
        status: "running",
        error: undefined,
      }));
    });
    const unsubCompleted = realtime.on("job.completed", (event) => {
      const data = event.data as { jobId?: unknown; status?: unknown; error?: unknown };
      if (data.jobId !== jobId) return;
      const failed = data.status !== "completed" && data.status !== "succeeded";
      setProgress((prev) => ({
        jobId,
        ratio: failed ? prev?.ratio : 1,
        etaMs: 0,
        message: prev?.message,
        status: failed ? "failed" : "completed",
        error: typeof data.error === "string" ? data.error : undefined,
      }));
    });
    realtime.connect();

    return () => {
      unsubProgress();
      unsubCompleted();
      realtime.disconnect();
    };
  }, [client, session, projectId, jobId]);

  return progress;
}
