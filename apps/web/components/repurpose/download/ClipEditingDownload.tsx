"use client";

/**
 * "For your editing app" (2026-10-01, OpusClip parity: their "Export XML"):
 * one clip as a ZIP a desktop editor opens - the clip without captions in the
 * size picked, its captions as subtitles, and a timeline for Final Cut Pro and
 * DaVinci Resolve (every caption a title on it) and one for Premiere Pro.
 *
 * Offered for the sizes whose version without captions is stored (a ready
 * clip's `formats` with a `cleanUrl`; an API older than `formats` has only the
 * 9:16, offered when the clip has that variant). The button asks for a
 * single-use link and sends the browser to it, as "Download all" does
 * (`RunDownloadAll.tsx`): the page stays where it is.
 *
 * Anyone who can see the run's clips can use it: they can already download
 * each of these files.
 */
import { Download } from "lucide-react";
import * as React from "react";

import type { RepurposeClipItem } from "@montaj/api-client";
import { Button, cn } from "@montaj/ui";

import { EDITING_DOWNLOAD_COPY, describeEditingDownloadError } from "./download-copy";
import { startDownload } from "./start-download";
import { useCreateClipEditingDownload } from "./use-clip-editing-download";

import { VIDEO_SHAPES, type VideoShape } from "@/components/repurpose/formats";

const SHAPE_OF_ASPECT: Readonly<Record<string, VideoShape>> = {
  r9x16: "9:16",
  r4x5: "4:5",
  r1x1: "1:1",
  r16x9: "16:9",
};

/** The sizes this clip can be downloaded for editing in, in the usual order. */
export function editingShapesOf(clip: RepurposeClipItem | undefined): VideoShape[] {
  if (clip === undefined || clip.state !== "ready") return [];
  const stored = new Set<VideoShape>();
  if (clip.formats === undefined) {
    for (const variant of clip.variants ?? []) {
      if (SHAPE_OF_ASPECT[variant.aspect] === "9:16") stored.add("9:16");
    }
  } else {
    for (const format of clip.formats) {
      if (format.cleanUrl !== null && format.projectId !== null) stored.add(format.shape);
    }
  }
  return VIDEO_SHAPES.filter((shape) => stored.has(shape));
}

export interface ClipEditingDownloadProps {
  readonly runId: string;
  readonly clip: RepurposeClipItem | undefined;
}

export function ClipEditingDownload({
  runId,
  clip,
}: ClipEditingDownloadProps): React.JSX.Element | null {
  const shapes = editingShapesOf(clip);
  const [picked, setPicked] = React.useState<VideoShape | null>(null);
  const create = useCreateClipEditingDownload();
  const shape = picked !== null && shapes.includes(picked) ? picked : shapes[0];
  if (clip === undefined || shape === undefined) return null;

  return (
    <section
      className="flex flex-col gap-1.5"
      aria-labelledby="clip-editing-download-heading"
      data-testid="clip-editing-download"
    >
      <span id="clip-editing-download-heading" className="text-xs text-fg-2">
        {EDITING_DOWNLOAD_COPY.heading}
      </span>
      <p className="m-0 text-2xs text-fg-2">{EDITING_DOWNLOAD_COPY.hint}</p>
      {shapes.length < 2 ? null : (
        <div
          role="radiogroup"
          aria-label={EDITING_DOWNLOAD_COPY.sizeLegend}
          className="flex flex-wrap gap-1"
        >
          {shapes.map((option) => {
            const selected = option === shape;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={selected}
                className={cn(
                  "rounded-sm border px-2 py-1 text-xs",
                  selected
                    ? "border-neutral-400 bg-bg-2 text-fg-0"
                    : "border-border bg-bg-0 text-fg-2 hover:text-fg-0",
                )}
                onClick={() => {
                  setPicked(option);
                  create.reset();
                }}
                data-testid={`clip-editing-shape-${option.replace(":", "x")}`}
              >
                {
                  // eslint-disable-next-line security/detect-object-injection -- `option` is one of VIDEO_SHAPES
                  EDITING_DOWNLOAD_COPY.shape[option]
                }
              </button>
            );
          })}
        </div>
      )}
      <Button
        variant="secondary"
        size="sm"
        className="justify-start"
        disabled={create.isPending}
        onClick={() => {
          create.mutate(
            { runId, clipId: clip.id, shape },
            {
              onSuccess: (link) => {
                startDownload(link.url);
              },
            },
          );
        }}
        data-testid="clip-editing-download-start"
      >
        <Download strokeWidth={1.75} aria-hidden="true" />
        {create.isPending ? EDITING_DOWNLOAD_COPY.starting : EDITING_DOWNLOAD_COPY.download}
      </Button>
      {create.isSuccess ? (
        <p
          className="m-0 text-2xs text-fg-2"
          role="status"
          data-testid="clip-editing-download-started"
        >
          {EDITING_DOWNLOAD_COPY.started}
        </p>
      ) : null}
      {create.isError ? (
        <p
          className="m-0 text-xs text-rejected"
          role="alert"
          data-testid="clip-editing-download-error"
        >
          {describeEditingDownloadError(create.error)}
        </p>
      ) : null}
    </section>
  );
}
