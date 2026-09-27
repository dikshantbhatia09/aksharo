"use client";

/**
 * The run page's way round YouTube (clips Wave B, 2026-09-27).
 *
 * While YouTube is refusing this server (`run.waitingFor`), the run is not
 * stuck: it waits and continues by itself, and this says until when. And a
 * person who has the video file does not have to wait, or start over: "Upload
 * the file instead" turns this link run into an upload run over the same
 * source project (`POST /repurpose/runs/{id}/source`), and the file goes up
 * through the same upload queue a new upload run uses - so the run keeps its
 * settings, and this page carries on from "Getting your video".
 *
 * Offered only where a file helps: the run is waiting for YouTube, or its
 * download failed for a reason a copy of the file gets round (blocked,
 * private, removed, ...). Never on an upload run, nor on a run that has its
 * video.
 */

import * as React from "react";

import { useRepurposeUpload, type RepurposeRunView } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import { SOURCE_UPLOAD_COPY } from "@/components/repurpose/copy";
import { describeRefusal } from "@/components/repurpose/refusal";
import { useUploadQueue } from "@/lib/upload/use-upload-queue";

/** Download failures a copy of the file gets round. */
const UPLOAD_HELPS: ReadonlySet<string> = new Set([
  "repurpose/source_blocked",
  "repurpose/source_unavailable",
  "repurpose/source_private",
  "repurpose/source_age_restricted",
  "repurpose/source_removed",
  "repurpose/source_live",
  "repurpose/stage_timeout",
]);

/** Whether the run page should offer "Upload the file instead" for `run`. */
export function offersUpload(run: RepurposeRunView): boolean {
  if (run.sourceKind === "upload") return false;
  if (run.waitingFor !== undefined && run.waitingFor !== null) return true;
  return (
    run.status === "failed" &&
    run.currentStage === "getting_video" &&
    run.failureCode !== null &&
    UPLOAD_HELPS.has(run.failureCode)
  );
}

/** "14:20", in the person's own clock. */
function localTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "a few minutes from now";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at);
}

export function SourceUploadOffer({
  run,
}: {
  readonly run: RepurposeRunView;
}): React.JSX.Element | null {
  const replaceSource = useRepurposeUpload();
  const uploads = useUploadQueue();
  const input = React.useRef<HTMLInputElement>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (!offersUpload(run)) return null;

  const onFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    // The same file picked twice still fires next time.
    event.target.value = "";
    if (file === undefined) return;
    setError(null);
    replaceSource.mutate(run.id, {
      onSuccess: (converted) => {
        // The queue calls `media/init` into the run's source project itself,
        // as a new upload run does; the run's language is the project's, so
        // the server starts the transcript once the file is prepared.
        uploads.addFilesToProjects([{ file, projectId: converted.sourceProjectId }], {
          aspect: "9:16",
        });
      },
      onError: (refusal) => {
        setError(describeRefusal(refusal, "useUpload").text);
      },
    });
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
      data-testid="source-upload-offer"
    >
      {run.waitingFor === undefined || run.waitingFor === null ? null : (
        <p className="m-0 text-sm text-fg-1" role="status" data-testid="source-waiting">
          {SOURCE_UPLOAD_COPY.waiting(localTime(run.waitingFor.until))}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="m-0 text-sm text-fg-2">{SOURCE_UPLOAD_COPY.offer}</p>
        <Button
          variant="secondary"
          size="sm"
          disabled={replaceSource.isPending}
          onClick={() => input.current?.click()}
          data-testid="source-upload-button"
        >
          {replaceSource.isPending ? SOURCE_UPLOAD_COPY.starting : SOURCE_UPLOAD_COPY.button}
        </Button>
        <input
          ref={input}
          type="file"
          accept="video/*,audio/*"
          className="hidden"
          onChange={onFile}
          data-testid="source-upload-input"
        />
      </div>
      {error === null ? null : (
        <p className="m-0 text-sm text-fg-1" role="alert" data-testid="source-upload-error">
          {error}
        </p>
      )}
    </div>
  );
}
