import { isApiError } from "@montaj/api-client";

import type { RunDownloadSummary } from "./use-run-download";

import { formatBytes } from "@/components/repurpose/failure-detail";

/** "Download all" (2026-10-01): every word the button and its dialog say. */
export const DOWNLOAD_ALL_COPY = Object.freeze({
  button: "Download all",
  title: "Download all",
  description:
    "Every clip in every size with captions, its images and the words to post, in one ZIP file.",
  // A selection (2026-10-01).
  selectedTitle: (count: number): string =>
    count === 1 ? "Download 1 clip" : `Download ${String(count)} clips`,
  selectedDescription:
    "Each clip you picked in every size with captions, its images and the words to post, in one ZIP file.",
  counting: "Counting what is ready…",
  withoutCaptions: "Also include every size without captions",
  size: (bytes: number): string => `Size: ${formatBytes(bytes)}`,
  extra: (bytes: number): string => `adds ${formatBytes(bytes)}`,
  coming: (count: number): string =>
    count === 1
      ? "1 clip is still being made and is not in it yet."
      : `${String(count)} clips are still being made and are not in it yet.`,
  progressNote: "Your browser shows the download as it goes. You can keep using Aksharo.",
  download: "Download ZIP",
  starting: "Starting…",
  started: "Your download has started. Your browser shows how far it has got.",
  close: "Close",
});

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** "35 clips · 140 videos · 35 dubbed videos · 385 images · 36 text files". */
export function contentsWords(summary: RunDownloadSummary): string {
  return [
    plural(summary.clips, "clip", "clips"),
    plural(summary.videos, "video", "videos"),
    summary.dubbedVideos > 0 ? plural(summary.dubbedVideos, "dubbed video", "dubbed videos") : "",
    summary.images > 0 ? plural(summary.images, "image", "images") : "",
    summary.texts > 0 ? plural(summary.texts, "text file", "text files") : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

export function describeDownloadError(error: unknown): string {
  if (!isApiError(error) || error.code.startsWith("network/")) {
    return "We could not reach Aksharo. Check your connection and try again.";
  }
  if (error.code === "repurpose/nothing_to_download") {
    return "No clip of this video is finished yet.";
  }
  return "That did not work. Try again.";
}

/**
 * "For your editing app" (2026-10-01, OpusClip's "Export XML"): one clip's
 * clean cut, captions and a timeline for a desktop editor. Plain words: the
 * person knows their editing app by name, not by its file format.
 */
export const EDITING_DOWNLOAD_COPY = Object.freeze({
  heading: "For your editing app",
  hint: "The clip without captions, its captions, and a timeline that opens in Premiere Pro, Final Cut Pro or DaVinci Resolve.",
  sizeLegend: "Size",
  shape: Object.freeze({
    "9:16": "9:16 tall",
    "4:5": "4:5",
    "1:1": "1:1 square",
    "16:9": "16:9 wide",
  }),
  download: "Download for editing",
  starting: "Starting…",
  started: "Your download has started. Unzip it and open the timeline in your editing app.",
});

export function describeEditingDownloadError(error: unknown): string {
  if (isApiError(error) && error.code === "repurpose/nle_not_ready") {
    return "This size is not ready yet. Try again when it is made.";
  }
  return describeDownloadError(error);
}
