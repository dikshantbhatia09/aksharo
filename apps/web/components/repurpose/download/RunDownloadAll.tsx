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
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" data-testid="download-all-dialog">
          <DialogHeader>
            <DialogTitle>{DOWNLOAD_ALL_COPY.title}</DialogTitle>
            <DialogDescription>{DOWNLOAD_ALL_COPY.description}</DialogDescription>
          </DialogHeader>
          {open ? (
            <DownloadBody
              runId={runId}
              onClose={() => {
                setOpen(false);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DownloadBody({
  runId,
  onClose,
}: {
  readonly runId: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const summary = useRunDownloadSummary(runId, true);
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
              <p className="m-0 text-sm text-accepted" role="status" data-testid="download-all-started">
                {DOWNLOAD_ALL_COPY.started}
              </p>
            ) : (
              <p className="m-0 text-xs text-fg-2">{DOWNLOAD_ALL_COPY.progressNote}</p>
            )}
            {create.isError ? (
              <p className="m-0 text-sm text-rejected" role="alert" data-testid="download-all-failed">
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
              { runId, includeClean },
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
