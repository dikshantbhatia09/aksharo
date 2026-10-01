"use client";

/**
 * The finished example run (2026-10-01, OpusClip's "try a sample project"):
 * `GET /repurpose/example`, one run the owner chose (`DEMO_RUN_ID` on the
 * API) that any signed-in person may open read only, so someone new sees
 * scored clips, why they scored, every size and the images before spending a
 * credit.
 *
 * Inert until the owner sets it: the API answers `{available: false}`, and
 * every entry point (`ExampleRunLink`, the gallery) shows nothing. A refusal
 * (the clips surface off for this workspace, a rate limit, the API down) reads
 * the same way: an example that cannot be opened is never offered.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, as the
 * results calls are (`results/use-results.ts`).
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import {
  defineEndpoint,
  useApiClient,
  useWorkspaceId,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
} from "@montaj/api-client";

import type { TranscriptLine } from "@/components/repurpose/results/use-results";

/** One clip's words, on the original video's clock. */
export interface ExampleTranscript {
  readonly offsetMs: number;
  readonly lines: readonly TranscriptLine[];
}

export interface ExampleRunView {
  readonly available: true;
  readonly run: {
    /** The video's title, or a plain stand-in; never a workspace's or a person's name. */
    readonly title: string;
    readonly source: "link" | "file";
    readonly automation: "auto" | "manual";
    /** How much of the video the run looked at, when known. */
    readonly processedMs: number | null;
    readonly clipCount: number;
  };
  readonly candidates: readonly RepurposeCandidateItem[];
  /** Finished clips only: no project to open, no clean cut, every URL signed. */
  readonly clips: readonly RepurposeClipItem[];
  /** Each clip's words, by moment id. */
  readonly transcripts: Readonly<Record<string, ExampleTranscript>>;
  /** When the earliest signed URL stops working. */
  readonly urlsExpireAt: string;
}

export type ExampleRunResponse = { readonly available: false } | ExampleRunView;

const exampleEndpoint = defineEndpoint<void, ExampleRunResponse>({
  method: "GET",
  path: "/repurpose/example",
  auth: "bearer",
});

/** Read again well before the signed URLs (an hour) stop working. */
export const EXAMPLE_REFRESH_MS = 20 * 60_000;

export function exampleQueryKey(workspaceId: string | null): readonly unknown[] {
  return ["repurpose-example", workspaceId ?? "none"];
}

/**
 * The example run, or `{available: false}`; an error is treated as no example
 * by callers. With no workspace (or `enabled` false) the query never runs and
 * stays `isPending` for good: callers wait on `isLoading`, never `isPending`.
 */
export function useExampleRun(enabled = true): UseQueryResult<ExampleRunResponse> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: exampleQueryKey(workspaceId),
    enabled: enabled && workspaceId !== null,
    staleTime: 5 * 60_000,
    refetchInterval: EXAMPLE_REFRESH_MS,
    retry: false,
    queryFn: () => client.call(exampleEndpoint),
  });
}

/** True only when an example run is set and can be shown. */
export function useExampleAvailable(): boolean {
  return useExampleRun().data?.available === true;
}
