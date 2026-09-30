"use client";

/**
 * Every format of one ready clip (2026-09-29), under its card on the run page.
 *
 * An Autopilot clip is made in four video shapes (9:16, 4:5, 1:1, 16:9), each
 * with captions burned in and a clean copy, and eleven image files taken from
 * them (posts, a carousel, a pin, a thumbnail, covers and banners). Each file
 * lists the places it fits (`FORMAT_TARGETS`), and says so when the clip is
 * longer than a place takes.
 *
 * Collapsed by default: the card's own 9:16 video is what most people want,
 * and forty clips with fifteen files each would bury it.
 */
import { AlertTriangle, Download, HardDrive, Loader2 } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import type { RepurposeClipFormat, RepurposeClipImages } from "@montaj/api-client";
import { Button } from "@montaj/ui";

import {
  FORMAT_TARGETS,
  IMAGE_FILES,
  VIDEO_SHAPE_SIZE,
  type FormatTarget,
  type ImageFileId,
  type VideoShape,
} from "@/components/repurpose/formats";


export const IMAGE_LABELS: Readonly<Record<ImageFileId, string>> = Object.freeze({
  "portrait-post": "Portrait post",
  carousel: "Carousel",
  "square-post": "Square post",
  "landscape-post": "Landscape post",
  "vertical-image": "Vertical image",
  pin: "Pin",
  thumbnail: "Thumbnail",
  "youtube-banner": "YouTube channel banner",
  "facebook-cover": "Facebook page cover",
  "facebook-event-cover": "Facebook event cover",
  "facebook-group-cover": "Facebook group cover",
});

const SHAPE_NAMES: Readonly<Record<VideoShape, string>> = Object.freeze({
  "9:16": "Vertical 9:16",
  "4:5": "Portrait 4:5",
  "1:1": "Square 1:1",
  "16:9": "Landscape 16:9",
});

export const FORMATS_COPY = Object.freeze({
  summary: "All formats",
  videos: "Videos",
  images: "Images",
  preparing: "Being made…",
  updating: "Updating with your caption changes…",
  failed: "Could not be made. Open it in the editor to export it.",
  imagesPreparing: "The images are taken once every video is made.",
  // The server's disk is below the floor that holds these (2026-09-30): not
  // being made, not stuck, and nothing the person has to do.
  waitingForSpace: "Waiting for storage space on our server. It is made as soon as there is room.",
  imagesWaitingForSpace:
    "Waiting for storage space on our server. The images are taken as soon as there is room.",
  imagesFailed: "The images could not be made.",
  withCaptions: "Download",
  withoutCaptions: "Without captions",
  edit: "Edit",
});

function isImageFileId(id: string): id is ImageFileId {
  return Object.hasOwn(IMAGE_FILES, id);
}

/** The places a file fits, as "Instagram Reel · YouTube Short". */
function usesOf(matches: (target: FormatTarget) => boolean): string {
  return FORMAT_TARGETS.filter(matches)
    .map((target) => `${target.platform} ${target.label}`)
    .join(" · ");
}

/** "Longer than an Instagram Story (60 s)" for each place the clip is too long for. */
export function tooLongFor(shape: VideoShape, durationMs: number): string[] {
  return FORMAT_TARGETS.filter(
    (target) =>
      target.file.kind === "video" &&
      target.file.shape === shape &&
      target.maxDurationMs !== undefined &&
      durationMs > target.maxDurationMs,
  ).map(
    (target) =>
      `${target.platform} ${target.label} takes up to ${String(Math.round((target.maxDurationMs ?? 0) / 1000))} s`,
  );
}

export interface ClipFormatsProps {
  readonly candidateId: string;
  readonly title: string;
  readonly durationMs: number;
  readonly formats: readonly RepurposeClipFormat[];
  readonly images: RepurposeClipImages | undefined;
}

export function ClipFormats({
  candidateId,
  title,
  durationMs,
  formats,
  images,
}: ClipFormatsProps): React.JSX.Element | null {
  const imageFiles = (images?.files ?? []).filter((file) => isImageFileId(file.id));
  // Only a clip with more than its own 9:16 video has anything to show here.
  if (formats.length <= 1 && imageFiles.length === 0 && images?.status !== "preparing") return null;
  const readyVideos = formats.filter((format) => format.status === "ready").length;

  return (
    <details
      className="rounded-sm border border-border bg-surface"
      data-testid={`clip-formats-${candidateId}`}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm text-fg-0">
        {FORMATS_COPY.summary}{" "}
        <span className="text-xs text-fg-2">
          {String(readyVideos)} of {String(formats.length)} videos · {String(imageFiles.length)}{" "}
          images
        </span>
      </summary>

      <div className="flex flex-col gap-4 border-t border-border px-3 py-3">
        <section aria-label={`${FORMATS_COPY.videos}: ${title}`}>
          <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
            {FORMATS_COPY.videos}
          </h4>
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {formats.map((format) => (
              <FormatRow
                key={format.shape}
                candidateId={candidateId}
                title={title}
                durationMs={durationMs}
                format={format}
              />
            ))}
          </ul>
        </section>

        <section aria-label={`${FORMATS_COPY.images}: ${title}`}>
          <h4 className="m-0 mb-2 text-xs font-semibold uppercase tracking-wide text-fg-2">
            {FORMATS_COPY.images}
          </h4>
          {images?.status === "preparing" && imageFiles.length === 0 ? (
            <p
              className="m-0 inline-flex items-center gap-1.5 text-xs text-fg-2"
              role="status"
              data-testid={`clip-images-status-${candidateId}`}
            >
              {images.waitingFor === "space" ? (
                <HardDrive className="size-4" strokeWidth={1.75} aria-hidden="true" />
              ) : (
                <Loader2 className="size-4 animate-spin" strokeWidth={1.75} aria-hidden="true" />
              )}
              {images.waitingFor === "space"
                ? FORMATS_COPY.imagesWaitingForSpace
                : FORMATS_COPY.imagesPreparing}
            </p>
          ) : images?.status === "failed" ? (
            <p className="m-0 inline-flex items-center gap-1.5 text-xs text-fg-2">
              <AlertTriangle
                className="size-4 text-rejected"
                strokeWidth={1.75}
                aria-hidden="true"
              />
              {FORMATS_COPY.imagesFailed}
            </p>
          ) : null}
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-0">
            {imageFiles.map((file) => {
              const id = file.id as ImageFileId;
              // eslint-disable-next-line security/detect-object-injection -- a checked image file id
              const label = IMAGE_LABELS[id];
              const first = file.items[0];
              return (
                <li
                  key={id}
                  className="flex flex-col gap-1.5"
                  data-testid={`clip-image-${candidateId}-${id}`}
                >
                  {first === undefined ? null : (
                    <div className="flex h-28 items-center justify-center overflow-hidden rounded-sm border border-border bg-ink">
                      {/* A signed object URL: not an asset Next can optimise. */}
                      <img
                        src={first.url}
                        alt={`${label}: ${title}`}
                        loading="lazy"
                        className="max-h-full max-w-full object-contain"
                      />
                    </div>
                  )}
                  <span className="text-xs text-fg-0">{label}</span>
                  <span className="font-mono text-2xs text-fg-2">
                    {String(file.width)} × {String(file.height)}
                  </span>
                  <span className="text-2xs text-fg-2">
                    {usesOf((target) => target.file.kind === "image" && target.file.image === id)}
                  </span>
                  <span className="flex flex-wrap gap-x-2 gap-y-1">
                    {file.items.map((item, index) => (
                      <a
                        key={item.downloadUrl}
                        href={item.downloadUrl}
                        download
                        className="text-xs text-fg-1"
                        aria-label={`Download ${label}${file.items.length > 1 ? ` slide ${String(index + 1)}` : ""}: ${title}`}
                      >
                        {file.items.length > 1 ? `Slide ${String(index + 1)}` : "Download"}
                      </a>
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </details>
  );
}

function FormatRow({
  candidateId,
  title,
  durationMs,
  format,
}: {
  readonly candidateId: string;
  readonly title: string;
  readonly durationMs: number;
  readonly format: RepurposeClipFormat;
}): React.JSX.Element {
  const size = VIDEO_SHAPE_SIZE[format.shape];
  const name = SHAPE_NAMES[format.shape];
  const download = format.captioned?.downloadUrl ?? null;
  const limits = tooLongFor(format.shape, durationMs);
  const waiting = format.waitingFor === "space";
  const note =
    format.status === "failed"
      ? FORMATS_COPY.failed
      : waiting
        ? FORMATS_COPY.waitingForSpace
        : format.status === "stale"
        ? FORMATS_COPY.updating
        : format.status === "preparing" ||
            format.status === "finishing" ||
            (format.status === "rendering" && download === null)
          ? FORMATS_COPY.preparing
          : null;
  return (
    <li
      className="flex flex-wrap items-start justify-between gap-2"
      data-testid={`clip-format-${candidateId}-${format.shape.replace(":", "x")}`}
      data-state={format.status}
    >
      <div className="min-w-0 flex-[1_1_220px]">
        <p className="m-0 text-sm text-fg-0">
          {name}{" "}
          <span className="font-mono text-2xs text-fg-2">
            {String(size.width)} × {String(size.height)}
          </span>
        </p>
        <p className="m-0 text-2xs text-fg-2">
          {usesOf((target) => target.file.kind === "video" && target.file.shape === format.shape)}
        </p>
        {limits.length === 0 ? null : (
          <p className="m-0 text-2xs text-warning">Too long for: {limits.join("; ")}.</p>
        )}
        {note === null ? null : (
          <p className="m-0 inline-flex items-center gap-1.5 text-xs text-fg-2" role="status">
            {format.status === "failed" ? (
              <AlertTriangle
                className="size-3.5 text-rejected"
                strokeWidth={1.75}
                aria-hidden="true"
              />
            ) : waiting ? (
              <HardDrive className="size-3.5" strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.75} aria-hidden="true" />
            )}
            {note}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {download === null ? null : (
          <Button variant="ghost" size="sm" asChild>
            <a
              href={download}
              download
              className="no-underline"
              aria-label={`Download ${name} video with captions: ${title}`}
            >
              <Download strokeWidth={1.75} aria-hidden="true" />
              {FORMATS_COPY.withCaptions}
            </a>
          </Button>
        )}
        {format.cleanUrl === null ? null : (
          <a
            href={format.cleanUrl}
            download
            className="text-xs text-fg-2"
            aria-label={`Download ${name} video without captions: ${title}`}
          >
            {FORMATS_COPY.withoutCaptions}
          </a>
        )}
        {format.projectId === null ? null : (
          <Link
            href={`/p/${format.projectId}`}
            className="text-xs text-fg-2"
            aria-label={`Edit the ${name} video: ${title}`}
          >
            {FORMATS_COPY.edit}
          </Link>
        )}
      </div>
    </li>
  );
}
