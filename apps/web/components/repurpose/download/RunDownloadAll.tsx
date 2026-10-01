"use client";

/**
 * "Download all" (2026-10-01): one ZIP of everything a run made - every clip
 * in every size with captions, each clip's images and words to post, its
 * dubbed versions, the compilations and the video's episode text - and, when
 * asked, every size without captions too.
 *
 * The dialog says what is in it and how big it is before anything starts
 * (`GET .../download`); "Download ZIP" asks for a single-use link and sends
 * the browser to it. The ZIP is made as it downloads, so it starts at once and
 * the browser shows its progress and time left; the page stays where it is.
 *
 * Anyone who can see the run's clips can download them all.
 *
 * The same dialog downloads the clips picked on the run's grid
 * (`RunDownloadDialog` with `clipIds`, 2026-10-01, OpusClip's multi-select
 * download): only those clips, without the video's compilations and episode
 * text.
 */
import { Download, HardDriveDownload } from "lucide-react";
import * as React from "react";

import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@montaj/ui";

import { DOWNLOAD_ALL_COPY, contentsWords, describeDownloadError } from "./download-copy";
import { startDownload } from "./start-download";
import { useCreateRunDownload, useRunDownloadSummary } from "./use-run-download";

export interface RunDownloadAllProps {
  readonly runId: string;
}

export interface RunDownloadDialogProps {
  readonly runId: string;
  /** Only these clips; every clip when absent. */
  readonly clipIds?: readonly string[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The download dialog on its own, for a selection made elsewhere. */
export function RunDownloadDialog({
  runId,
  clipIds,
  open,
  onOpenChange,
}: RunDownloadDialogProps): React.JSX.Element {
  const picked = clipIds?.length;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="download-all-dialog">
        <DialogHeader>
          <DialogTitle>
            {picked === undefined
              ? DOWNLOAD_ALL_COPY.title
              : DOWNLOAD_ALL_COPY.selectedTitle(picked)}
          </DialogTitle>
          <DialogDescription>
            {picked === undefined
              ? DOWNLOAD_ALL_COPY.description
              : DOWNLOAD_ALL_COPY.selectedDescription}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <DownloadBody
            runId={runId}
            {...(clipIds === undefined ? {} : { clipIds })}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export function RunDownloadAll({ runId }: RunDownloadAllProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <div data-testid="download-all">
      <Button
        variant="secondary"
        size="sm"
        className="h-11 sm:h-8"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="download-all-open"
      >
        <Download strokeWidth={1.75} aria-hidden="true" />
        {DOWNLOAD_ALL_COPY.button}
      </Button>
      <RunDownloadDialog runId={runId} open={open} onOpenChange={setOpen} />
    </div>
  );
}

function DownloadBody({
  runId,
  clipIds,
  onClose,
}: {
  readonly runId: string;
  readonly clipIds?: readonly string[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const summary = useRunDownloadSummary(runId, true, clipIds);
  const create = useCreateRunDownload();
  const [includeClean, setIncludeClean] = React.useState(false);
  const [started, setStarted] = React.useState(false);
  const data = summary.data;
  const bytes = data === undefined ? 0 : includeClean ? data.bytesWithClean : data.bytes;

  return (
    <>
      <div className="flex flex-col gap-4">
        {summary.isPending ? (
          <p className="m-0 text-sm text-fg-2" role="status" data-testid="download-all-counting">
            {DOWNLOAD_ALL_COPY.counting}
          </p>
        ) : summary.isError || data === undefined ? (
          <p className="m-0 text-sm text-rejected" role="alert" data-testid="download-all-error">
            {describeDownloadError(summary.error)}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <p className="m-0 text-sm text-fg-0" data-testid="download-all-contents">
                {contentsWords(data)}
              </p>
              {data.clipsComing > 0 ? (
                <p className="m-0 text-xs text-fg-2" data-testid="download-all-coming">
                  {DOWNLOAD_ALL_COPY.coming(data.clipsComing)}
                </p>
              ) : null}
            </div>

            {data.cleanVideos > 0 ? (
              <label className="flex min-h-11 items-start gap-3 text-sm text-fg-0 sm:min-h-0">
                <Checkbox
                  className="mt-0.5"
                  checked={includeClean}
                  onCheckedChange={(value) => {
                    setIncludeClean(value === true);
                  }}
                  data-testid="download-all-clean"
                />
                <span>
                  {DOWNLOAD_ALL_COPY.withoutCaptions}{" "}
                  <span className="text-fg-2">
                    ({DOWNLOAD_ALL_COPY.extra(data.bytesWithClean - data.bytes)})
                  </span>
                </span>
              </label>
            ) : null}

            <p
              className="m-0 inline-flex items-center gap-1.5 text-sm text-fg-1"
              data-testid="download-all-size"
            >
              <HardDriveDownload className="size-4" strokeWidth={1.75} aria-hidden="true" />
              {DOWNLOAD_ALL_COPY.size(bytes)}
            </p>

            {started ? (
              <p
                className="m-0 text-sm text-accepted"
                role="status"
                data-testid="download-all-started"
              >
                {DOWNLOAD_ALL_COPY.started}
              </p>
            ) : (
              <p className="m-0 text-xs text-fg-2">{DOWNLOAD_ALL_COPY.progressNote}</p>
            )}
            {create.isError ? (
              <p
                className="m-0 text-sm text-rejected"
                role="alert"
                data-testid="download-all-failed"
              >
                {describeDownloadError(create.error)}
              </p>
            ) : null}
          </>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          {DOWNLOAD_ALL_COPY.close}
        </Button>
        <Button
          variant="primary"
          disabled={data === undefined || data.clips === 0 || create.isPending}
          onClick={() => {
            create.mutate(
              { runId, includeClean, ...(clipIds === undefined ? {} : { clipIds }) },
              {
                onSuccess: (link) => {
                  setStarted(true);
                  startDownload(link.url);
                },
              },
            );
          }}
          data-testid="download-all-start"
        >
          {create.isPending ? DOWNLOAD_ALL_COPY.starting : DOWNLOAD_ALL_COPY.download}
        </Button>
      </DialogFooter>
    </>
  );
}
