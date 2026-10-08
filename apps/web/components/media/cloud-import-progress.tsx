"use client";

import * as React from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Card, cn } from "@montaj/ui";
import type { CloudImportJobResponse } from "@montaj/api-client";

export interface CloudImportProgressProps {
  readonly jobId: string;
  readonly fileName: string;
  readonly provider: "GOOGLE_DRIVE" | "DROPBOX" | string;
  readonly onCompleted?: (job: CloudImportJobResponse) => void;
  readonly onFailed?: (error: string) => void;
  readonly className?: string;
}

export function CloudImportProgress({
  jobId,
  fileName,
  provider,
  onCompleted,
  onFailed,
  className,
}: CloudImportProgressProps): React.JSX.Element {
  const [job, setJob] = React.useState<CloudImportJobResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;

    const pollStatus = async (): Promise<void> => {
      try {
        const response = await fetch(`/api/v1/media/cloud-import/${encodeURIComponent(jobId)}`, {
          headers: {
            "Accept": "application/json",
          },
        });

        if (!response.ok) {
          throw new Error(`Failed to check cloud transfer status: ${response.statusText}`);
        }

        const data = (await response.json()) as CloudImportJobResponse;
        if (cancelled) return;

        setJob(data);

        if (data.status === "COMPLETED") {
          onCompleted?.(data);
        } else if (data.status === "FAILED") {
          const errMsg = data.errorMessage || "Transfer failed from cloud storage provider.";
          setError(errMsg);
          onFailed?.(errMsg);
        } else {
          // Poll again in 1.5 seconds
          timer = setTimeout(pollStatus, 1500);
        }
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        onFailed?.(msg);
      }
    };

    pollStatus();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, onCompleted, onFailed]);

  const progressPct = job?.progressPct ?? 0;
  const status = job?.status ?? "QUEUED";

  const providerLabel =
    provider === "GOOGLE_DRIVE"
      ? "Google Drive"
      : provider === "DROPBOX"
      ? "Dropbox"
      : provider;

  return (
    <Card
      className={cn("p-4 border bg-surface flex flex-col gap-3", className)}
      data-testid="cloud-import-progress-card"
    >
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 truncate">
          {status === "FAILED" || error ? (
            <AlertCircle className="size-4 text-red-500 shrink-0" />
          ) : status === "COMPLETED" ? (
            <CheckCircle2 className="size-4 text-green-500 shrink-0" />
          ) : (
            <Loader2 className="size-4 animate-spin text-accent shrink-0" />
          )}
          <span className="font-medium text-fg-0 truncate max-w-[260px]" title={fileName}>
            {fileName}
          </span>
          <span className="text-xs text-fg-2">({providerLabel})</span>
        </div>
        <span className="text-xs font-mono font-medium text-fg-1">
          {status === "COMPLETED"
            ? "100%"
            : status === "FAILED"
            ? "Error"
            : `${progressPct}%`}
        </span>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-sunken rounded-full h-1.5 overflow-hidden">
        <div
          className={cn(
            "h-full transition-all duration-300 ease-out",
            status === "FAILED" || error
              ? "bg-red-500"
              : status === "COMPLETED"
              ? "bg-green-500"
              : "bg-accent",
          )}
          style={{ width: `${status === "COMPLETED" ? 100 : progressPct}%` }}
        />
      </div>

      <div className="text-xs text-fg-2 flex items-center justify-between">
        <span>
          {status === "QUEUED" && "Connecting to cloud storage…"}
          {status === "STREAMING" && "Streaming directly to storage (zero-disk)…"}
          {status === "COMPLETED" && "Transfer complete! Ready to process."}
          {status === "FAILED" && (error || "Cloud import failed.")}
        </span>
        {status === "STREAMING" && (
          <span className="text-[11px] text-fg-muted">Server-to-Server direct pipe</span>
        )}
      </div>
    </Card>
  );
}

