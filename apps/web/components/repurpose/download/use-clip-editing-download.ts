"use client";

/**
 * "For your editing app" (2026-10-01): a single-use link to one clip's ZIP for
 * a desktop editor (its clean cut in one size, the captions as subtitles, and
 * timelines for Premiere Pro, Final Cut Pro and DaVinci Resolve). The API
 * writes the timelines from the clip's editing document when the link is used,
 * so an edit made in Aksharo's editor a minute ago is in them.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, as
 * "Download all" is (`use-run-download.ts`).
 */
import { useMutation, type UseMutationResult } from "@tanstack/react-query";

import { defineEndpoint, useApiClient } from "@montaj/api-client";

import type { RunDownloadLink } from "./use-run-download";
import type { VideoShape } from "@/components/repurpose/formats";

const createEndpoint = defineEndpoint<{ readonly shape: VideoShape }, RunDownloadLink>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/nle-download",
  auth: "bearer",
});

export function useCreateClipEditingDownload(): UseMutationResult<
  RunDownloadLink,
  Error,
  { readonly runId: string; readonly clipId: string; readonly shape: VideoShape }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (input) =>
      client.call(createEndpoint, {
        params: { runId: input.runId, clipId: input.clipId },
        body: { shape: input.shape },
      }),
  });
}
