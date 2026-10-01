"use client";

/**
 * The run results page's calls (2026-10-01, OpusClip parity): rename a clip,
 * switch Autopilot's hook titles for a run, a clip's words on the original's
 * clock, and what a new run would cost.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, as the
 * guest and review calls are (`guest/use-guest-links.ts`).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, queryKeys, useApiClient, useWorkspaceId } from "@montaj/api-client";

export interface TranscriptLine {
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface RunEstimate {
  readonly creditsLeft: number;
  readonly planWindowMs: number;
  readonly windowMs: number;
  readonly maxSourceDurationMs: number;
  readonly processMs: number;
  readonly trimmed: boolean;
  readonly processCredits: number;
  readonly finishedVideos: {
    readonly clips: number;
    readonly videos: number;
    readonly credits: number;
  } | null;
  readonly totalCredits: number;
}

const retitleEndpoint = defineEndpoint<
  { readonly title: string },
  { readonly candidateId: string; readonly title: string }
>({
  method: "PUT",
  path: "/repurpose/runs/{runId}/candidates/{candidateId}/title",
  auth: "bearer",
});

const hookTitlesEndpoint = defineEndpoint<
  { readonly enabled: boolean },
  { readonly enabled: boolean; readonly changed: number }
>({
  method: "PUT",
  path: "/repurpose/runs/{runId}/hook-titles",
  auth: "bearer",
});

const transcriptEndpoint = defineEndpoint<
  void,
  { readonly offsetMs: number; readonly lines: readonly TranscriptLine[] }
>({
  method: "GET",
  path: "/repurpose/runs/{runId}/candidates/{candidateId}/transcript",
  auth: "bearer",
});

const estimateEndpoint = defineEndpoint<void, RunEstimate>({
  method: "GET",
  path: "/repurpose/estimate",
  auth: "bearer",
});

/** Renames a clip; the run's candidates and clips are read again after. */
export function useRetitleClip(): UseMutationResult<
  { readonly candidateId: string; readonly title: string },
  Error,
  { readonly runId: string; readonly candidateId: string; readonly title: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(retitleEndpoint, {
        params: { runId: input.runId, candidateId: input.candidateId },
        body: { title: input.title },
      }),
    onSettled: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.repurposeScope(workspaceId) });
    },
  });
}

/** Switches Autopilot's hook titles for a run; the run is read again after. */
export function useHookTitles(): UseMutationResult<
  { readonly enabled: boolean; readonly changed: number },
  Error,
  { readonly runId: string; readonly enabled: boolean }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(hookTitlesEndpoint, {
        params: { runId: input.runId },
        body: { enabled: input.enabled },
      }),
    onSettled: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.repurposeScope(workspaceId) });
    },
  });
}

export function useClipTranscript(
  runId: string,
  candidateId: string,
  enabled: boolean,
): UseQueryResult<{ readonly offsetMs: number; readonly lines: readonly TranscriptLine[] }> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: ["clip-transcript", workspaceId ?? "none", runId, candidateId],
    enabled: enabled && workspaceId !== null,
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: () => client.call(transcriptEndpoint, { params: { runId, candidateId } }),
  });
}

/**
 * What a new run would cost, for the start form: the length when known (an
 * upload's), Autopilot or not, and the clip length asked for.
 */
export function useRunEstimate(input: {
  readonly durationMs?: number;
  readonly automation: "auto" | "manual";
  readonly clipLength?: "short" | "medium" | "long";
  readonly enabled: boolean;
}): UseQueryResult<RunEstimate> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const query: Record<string, string> = { automation: input.automation };
  if (input.durationMs !== undefined && input.durationMs > 0) {
    query["durationMs"] = String(Math.round(input.durationMs));
  }
  if (input.clipLength !== undefined) query["clipLength"] = input.clipLength;
  return useQuery({
    queryKey: ["run-estimate", workspaceId ?? "none", query],
    enabled: input.enabled && workspaceId !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: () => client.call(estimateEndpoint, { query }),
  });
}
