"use client";

/**
 * The in-flight upload list under Home's drop zone: one row per file, each
 * driven by its own `UploadJob` through `useUploadQueue`. `JobProgress`'s
 * four stages (Uploading → Transcribing → Aligning → Ready, 08 §2) are a
 * close but not exact fit for `UploadStatus` — hashing, creating the
 * project and completing the multipart upload are all still "Uploading" from
 * here, and `error`, `cancelled` and `duplicate` are not stages at all — so
 * this maps the ones that fit and renders the rest as their own row.
 */
import { useRouter } from "next/navigation";
import * as React from "react";

import { useRawApiClient } from "@montaj/api-client";
import { Button, Card, JobProgress } from "@montaj/ui";
import type { JobStage } from "@montaj/ui";

import { DidYouKnow, PROCESSING_TIPS, useRotatingTip } from "./processing-tips";

import type { UploadItemState, UploadStatus } from "@/lib/upload/types";

import { getTranscriptionState, type TranscriptionStateView } from "@/lib/edg/transcription-state";

function stageFor(status: UploadStatus): JobStage {
  switch (status) {
    case "hashing":
    case "creating-project":
    case "uploading":
    case "paused":
    case "completing":
    case "processing":
      // FIX-03: on `processing` the bytes are up but the server is still
      // probing/proxying and transcription has NOT begun. There is no chip for
      // that stage, and lighting "Transcribing" was exactly the lie this package
      // removes — so the intake chip stays active and the row's own status line
      // below carries the precise truth.
      return "uploading";
    case "transcribing":
      return "transcribing";
    case "ready":
    case "duplicate":
    case "cancelled":
    case "error":
      return "ready";
  }
}

/** 4 s -> 8 s -> 15 s: a per-visible-row poll, bounded by what is on screen. */
const ROW_BACKOFF_MS = [4_000, 8_000, 15_000] as const;

/** Still moving — the only answers worth another request. */
const ROW_POLLING: ReadonlySet<TranscriptionStateView["status"]> = new Set([
  "queued",
  "running",
  "processing_media",
]);

/** The rows whose truth lives in the server pipeline rather than in the upload. */
function serverOwned(status: UploadStatus): boolean {
  return status === "processing" || status === "transcribing";
}

function labelFor(state: TranscriptionStateView): string {
  switch (state.status) {
    case "queued":
    case "running":
      return "Transcribing…";
    case "ready":
      return "Ready — open the editor";
    case "failed":
      return state.error ?? "The transcription failed.";
    case "awaiting_language":
    case "not_started":
      return "Needs attention — open the project";
    case "processing_media":
    case "no_media":
      return "Processing on the server…";
  }
}

/**
 * One row's live word on what the server is doing, polled from FIX-03's read
 * model. Mounted only for a row the server owns, so the request rate is bounded
 * by the rows a user can actually see — and it stops the moment the answer
 * settles or the row unmounts.
 */
function RowPipelineStatus({
  projectId,
  fallback,
}: {
  projectId: string | undefined;
  fallback: string;
}): React.JSX.Element {
  const client = useRawApiClient();
  const [label, setLabel] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (projectId === undefined) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function tick(): Promise<void> {
      try {
        const state = await client.call(getTranscriptionState, {
          params: { projectId: projectId ?? "" },
        });
        if (cancelled) return;
        setLabel(labelFor(state));
        if (!ROW_POLLING.has(state.status)) return;
      } catch {
        if (cancelled) return;
      }
      const delay = ROW_BACKOFF_MS[Math.min(attempt, ROW_BACKOFF_MS.length - 1)] ?? 15_000;
      attempt += 1;
      timer = setTimeout(() => void tick(), delay);
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, projectId]);

  return (
    <p className="text-fg-2 text-xs" data-testid="upload-tray-pipeline-status">
      {label ?? fallback}
    </p>
  );
}

/**
 * K02: the same "Did you know?" rotator the full-screen states use
 * (`processing-tips.tsx`), scaled down for a tray row. Mounted only while the
 * row is server-owned, same as {@link RowPipelineStatus} above — a finished
 * or still-uploading row has no tip to show and no timer running.
 */
function RowTip(): React.JSX.Element {
  const tip = useRotatingTip(PROCESSING_TIPS, 6_000);
  return <DidYouKnow tip={tip} className="mt-1" />;
}

export function UploadTray({
  items,
  pause,
  resume,
  cancel,
  dismiss,
}: {
  items: readonly UploadItemState[];
  pause: (id: string) => void;
  resume: (id: string) => void;
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
}): React.JSX.Element | null {
  const router = useRouter();
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2" data-testid="upload-tray" aria-label="Uploads">
      {items.map((item) => {
        const percent =
          item.progress.totalBytes > 0
            ? (item.progress.uploadedBytes / item.progress.totalBytes) * 100
            : 0;

        return (
          <Card key={item.id} className="flex flex-col gap-2 p-4" data-testid="upload-tray-item">
            <div className="flex items-center justify-between gap-2">
              <span className="text-fg-0 truncate text-sm font-medium">{item.fileName}</span>
              <div className="flex shrink-0 items-center gap-1.5">
                {item.status === "uploading" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      pause(item.id);
                    }}
                    data-testid="upload-pause"
                  >
                    Pause
                  </Button>
                ) : null}
                {item.status === "paused" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      resume(item.id);
                    }}
                    data-testid="upload-resume"
                  >
                    Resume
                  </Button>
                ) : null}
                {/* FIX-03: the project is openable as soon as the server owns the
                    work — waiting for a "ready" this row can no longer honestly
                    claim would leave the user with no way in. */}
                {item.projectId !== undefined &&
                (item.status === "ready" || serverOwned(item.status)) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      router.push(`/p/${item.projectId}`);
                    }}
                  >
                    Open project
                  </Button>
                ) : null}
                {item.status === "ready" ||
                item.status === "error" ||
                item.status === "cancelled" ||
                item.status === "duplicate" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      dismiss(item.id);
                    }}
                    data-testid="upload-dismiss"
                  >
                    Dismiss
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      cancel(item.id);
                    }}
                    data-testid="upload-cancel"
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </div>

            {item.status === "duplicate" ? (
              <p className="text-fg-2 text-xs">
                Already in your workspace.{" "}
                {item.duplicateOfProjectId === undefined ? null : (
                  <a
                    href={`/p/${item.duplicateOfProjectId}`}
                    className="text-accent-300 hover:text-accent-200 underline underline-offset-4"
                    data-testid="duplicate-open-original"
                  >
                    Open the original
                  </a>
                )}
              </p>
            ) : (
              <>
                <JobProgress
                  stage={stageFor(item.status)}
                  progress={item.status === "uploading" ? percent : undefined}
                  {...(item.error === undefined ? {} : { error: item.error })}
                  {...(item.error === undefined
                    ? {}
                    : {
                        onRetry: () => {
                          resume(item.id);
                        },
                      })}
                />
                {serverOwned(item.status) ? (
                  <>
                    <RowPipelineStatus
                      projectId={item.projectId}
                      fallback={
                        item.status === "processing" ? "Processing on the server…" : "Transcribing…"
                      }
                    />
                    <RowTip />
                  </>
                ) : null}
              </>
            )}
          </Card>
        );
      })}
    </section>
  );
}
