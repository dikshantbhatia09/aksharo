"use client";

/**
 * Per-project batch progress (B15 brief §4: "Batch progress view with
 * per-project status and one-click export-all"). Polls `GET /batch/:id`
 * (`useBatch`, `refetchInterval: 4000`) — the same "poll while mounted"
 * pattern `UploadTray` uses for its own in-flight uploads.
 *
 * "One-click export-all" here is "apply" (`POST /batch/:id/apply`): enqueue
 * transcription for every project in the batch that already has a probed
 * media asset. A project the caller's own upload queue has not finished
 * uploading yet simply reports `null`/`draft` until applied again.
 */

import * as React from "react";

import { Badge, Button, ProgressBar } from "@montaj/ui";

import { useApplyBatch, useBatch } from "@/lib/share/hooks";

/** Signal hues, never the accent: a list of badges is not an accent moment. */
function statusTone(status: string | null): "neutral" | "info" | "rejected" | "accepted" {
  if (status === null) return "neutral";
  if (status === "failed" || status === "dlq") return "rejected";
  if (status === "succeeded") return "accepted";
  return "info";
}

export function BatchProgressView({ batchId }: { batchId: string }): React.JSX.Element {
  const batch = useBatch(batchId);
  const apply = useApplyBatch(batchId);

  if (batch.isPending) {
    return (
      <div
        className="border-border bg-surface rounded-md border p-5"
        data-testid="batch-progress-loading"
        role="status"
      >
        <p className="text-fg-2 text-sm">Loading batch…</p>
      </div>
    );
  }

  if (batch.data === undefined) {
    return (
      <div
        className="border-border bg-surface rounded-md border p-5"
        data-testid="batch-progress-error"
      >
        <p className="text-fg-2 text-sm">
          This batch could not be loaded. Its projects are still in your project list.
        </p>
      </div>
    );
  }

  const total = batch.data.projects.length;
  const done = batch.data.projects.filter(
    (project) => project.latestJobStatus === "succeeded",
  ).length;

  return (
    <div
      className="border-border bg-surface flex flex-col gap-3 rounded-md border p-5"
      data-testid="batch-progress-view"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-fg-0 text-base font-semibold">
          Batch: {done} of {total} transcribed
        </h2>
        <Button
          type="button"
          size="sm"
          disabled={apply.isPending}
          onClick={() => apply.mutate(batch.data.settings)}
          data-testid="batch-apply-button"
        >
          {apply.isPending ? "Starting…" : "Transcribe all"}
        </Button>
      </div>
      <ProgressBar
        value={total === 0 ? 0 : (done / total) * 100}
        label={`${String(done)} of ${String(total)} projects transcribed`}
      />
      <ul className="flex flex-col gap-2">
        {batch.data.projects.map((project) => (
          <li
            key={project.projectId}
            className="flex items-center justify-between gap-2 text-sm"
            data-testid="batch-project-row"
          >
            <span className="text-fg-0 truncate">{project.title}</span>
            <Badge tone={statusTone(project.latestJobStatus)}>
              {project.latestJobStatus ?? "waiting for upload"}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
