"use client";

/**
 * "Download all" (2026-10-01): what a run's ZIP holds and how big it is, and
 * a single-use link to it.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, as the
 * guest and review calls are (`guest/use-guest-links.ts`).
 */
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, useApiClient, useWorkspaceId } from "@montaj/api-client";

export interface RunDownloadSummary {
  /** Clips with files in the ZIP. */
  readonly clips: number;
  /** Clips with nothing finished yet. */
  readonly clipsComing: number;
  /** Captioned videos: every shape of every clip, and the compilations. */
  readonly videos: number;
  readonly dubbedVideos: number;
  readonly images: number;
  /** Words to post, and the video's episode text. */
  readonly texts: number;
  readonly bytes: number;
  /** Versions without captions the ZIP adds when asked. */
  readonly cleanVideos: number;
  readonly bytesWithClean: number;
  readonly filename: string;
}

export interface RunDownloadLink {
  readonly url: string;
  readonly expiresAt: string;
}

const summaryEndpoint = defineEndpoint<void, RunDownloadSummary>({
  method: "GET",
  path: "/repurpose/runs/{runId}/download",
  auth: "bearer",
});

const createEndpoint = defineEndpoint<
  { readonly includeClean: boolean; readonly clipIds?: readonly string[] },
  RunDownloadLink
>({
  method: "POST",
  path: "/repurpose/runs/{runId}/download",
  auth: "bearer",
});

/** The run's ZIP, or (with `clipIds`, 2026-10-01) the ZIP of the clips picked. */
export function useRunDownloadSummary(
  runId: string,
  enabled: boolean,
  clipIds?: readonly string[],
): UseQueryResult<RunDownloadSummary> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const picked = clipIds === undefined ? "" : clipIds.join(",");
  return useQuery({
    queryKey: ["run-download", workspaceId ?? "none", runId, picked],
    enabled: enabled && workspaceId !== null,
    // Sizes change as clips are made: asked again each time the dialog opens.
    staleTime: 0,
    retry: false,
    queryFn: () =>
      client.call(summaryEndpoint, {
        params: { runId },
        ...(picked === "" ? {} : { query: { clipIds: picked } }),
      }),
  });
}

export function useCreateRunDownload(): UseMutationResult<
  RunDownloadLink,
  Error,
  {
    readonly runId: string;
    readonly includeClean: boolean;
    readonly clipIds?: readonly string[];
  }
> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (input) =>
      client.call(createEndpoint, {
        params: { runId: input.runId },
        body: {
          includeClean: input.includeClean,
          ...(input.clipIds === undefined ? {} : { clipIds: input.clipIds }),
        },
      }),
  });
}
