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

import { Button, Card, JobProgress } from "@montaj/ui";
import type { JobStage } from "@montaj/ui";

import type { UploadItemState, UploadStatus } from "@/lib/upload/types";

function stageFor(status: UploadStatus): JobStage {
  switch (status) {
    case "hashing":
    case "creating-project":
    case "uploading":
    case "paused":
    case "completing":
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
    <div className="flex flex-col gap-2" data-testid="upload-tray">
      {items.map((item) => {
        const percent =
          item.progress.totalBytes > 0
            ? (item.progress.uploadedBytes / item.progress.totalBytes) * 100
            : 0;

        return (
          <Card key={item.id} className="flex flex-col gap-2 p-3" data-testid="upload-tray-item">
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
                {item.status === "ready" && item.projectId !== undefined ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      router.push(`/p/${item.projectId}`);
                    }}
                  >
                    Open
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
                    className="text-lime-500 underline"
                    data-testid="duplicate-open-original"
                  >
                    Open the original
                  </a>
                )}
              </p>
            ) : (
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
            )}
          </Card>
        );
      })}
    </div>
  );
}
