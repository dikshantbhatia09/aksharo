"use client";

/**
 * One clip of the example run (2026-10-01), as its card in the list and in
 * the clip view: the captioned 9:16 video to play, a single download of it,
 * every other size and the images (`ClipFormats`, which offers no editor link
 * and no clean cut here because the API sends neither), and the words to post
 * (`ClipCopyPanel`, copy buttons only).
 *
 * Nothing on it writes: no dub, review, posting, layout or re-cut control -
 * the run page's own `CandidateCard` carries those, and every one is a route
 * of the run's own workspace.
 */
import { Download } from "lucide-react";
import * as React from "react";

import {
  clipCopyOf,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
} from "@montaj/api-client";
import { Button } from "@montaj/ui";

import { ClipCopyPanel } from "@/components/repurpose/ClipCopyPanel";
import { ClipFormats } from "@/components/repurpose/ClipFormats";
import { formatClock } from "@/components/repurpose/moment-time";

export interface ExampleClipCardProps {
  readonly candidate: RepurposeCandidateItem;
  readonly clip: RepurposeClipItem | undefined;
  /** In the list: opens the clip view with its analysis and words. */
  readonly onOpenDetails?: () => void;
}

function posterOf(clip: RepurposeClipItem | undefined): string | undefined {
  const files = clip?.images?.files ?? [];
  const vertical =
    files.find((file) => file.id === "vertical-image") ??
    files.find((file) => file.height > file.width);
  return vertical?.items[0]?.url;
}

export function ExampleClipCard({
  candidate,
  clip,
  onOpenDetails,
}: ExampleClipCardProps): React.JSX.Element {
  const copy = clipCopyOf(clip?.copy) ?? clipCopyOf(candidate.copy);
  const title = copy?.title ?? candidate.title ?? candidate.headline ?? "Suggested moment";
  const score = candidate.potentialScore ?? candidate.score ?? null;
  const durationMs = clip?.captioned?.durationMs ?? candidate.endMs - candidate.startMs;
  const playUrl = clip?.captioned?.playUrl ?? null;
  const downloadUrl = clip?.captioned?.downloadUrl ?? null;
  const poster = posterOf(clip);

  return (
    <li
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 sm:flex-row"
      data-testid={`example-clip-${candidate.id}`}
    >
      {playUrl === null ? null : (
        <video
          src={playUrl}
          {...(poster === undefined ? {} : { poster })}
          controls
          playsInline
          preload="none"
          className="aspect-[9/16] w-full max-w-[220px] shrink-0 self-center rounded-sm bg-ink sm:self-start"
          aria-label={`${title}, with captions`}
          data-testid={`example-clip-video-${candidate.id}`}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-base font-semibold text-fg-0">{title}</h3>
          <p className="m-0 text-xs text-fg-2">
            {score === null ? "" : `Score ${String(score)} · `}
            {formatClock(durationMs)} long
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {downloadUrl === null ? null : (
            <Button variant="secondary" size="sm" asChild>
              <a
                href={downloadUrl}
                download
                className="no-underline"
                aria-label={`Download the video with captions: ${title}`}
                data-testid={`example-clip-download-${candidate.id}`}
              >
                <Download strokeWidth={1.75} aria-hidden="true" />
                Download video
              </a>
            </Button>
          )}
          {onOpenDetails === undefined ? null : (
            <Button
              variant="ghost"
              size="sm"
              onClick={onOpenDetails}
              data-testid={`example-clip-details-${candidate.id}`}
            >
              Why it scored
            </Button>
          )}
        </div>
        <ClipFormats
          candidateId={candidate.id}
          title={title}
          durationMs={durationMs}
          formats={clip?.formats ?? []}
          images={clip?.images}
        />
        {copy === null ? null : (
          <ClipCopyPanel candidateId={candidate.id} title={title} copy={copy} />
        )}
      </div>
    </li>
  );
}
