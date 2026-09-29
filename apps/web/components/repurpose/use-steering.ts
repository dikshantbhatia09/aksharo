"use client";

/**
 * The run page's steering calls (2026-09-29): remove a moment and its clip,
 * bring it back, and change its start and end.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index, the same way the
 * clips hardening's own routes were described ahead of it (`hooks.ts`).
 * Each settles by refetching the run's moments, its clips and the run: what
 * the server did (a clip hidden, one promoted in its place, a cut started) is
 * read back rather than guessed at.
 */
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import {
  defineEndpoint,
  queryKeys,
  useApiClient,
  useWorkspaceId,
  type RepurposeCandidateItem,
  type RepurposeClipItem,
} from "@montaj/api-client";

/** What each of the three answers with. */
export interface SteeringResponse {
  readonly candidate: RepurposeCandidateItem;
  /** The moment's clip, when the call asked for it to be cut again. */
  readonly clip: RepurposeClipItem | null;
  /** On an Autopilot run, the moments given a clip in a removed one's place. */
  readonly promoted: readonly string[];
}

const removeEndpoint = defineEndpoint<void, SteeringResponse>({
  method: "POST",
  path: "/repurpose/runs/{runId}/candidates/{candidateId}/remove",
  auth: "bearer",
});

const restoreEndpoint = defineEndpoint<void, SteeringResponse>({
  method: "POST",
  path: "/repurpose/runs/{runId}/candidates/{candidateId}/restore",
  auth: "bearer",
});

const adjustEndpoint = defineEndpoint<
  { readonly startMs: number; readonly endMs: number },
  SteeringResponse
>({
  method: "PATCH",
  path: "/repurpose/runs/{runId}/candidates/{candidateId}",
  auth: "bearer",
});

export interface MomentRef {
  readonly runId: string;
  readonly candidateId: string;
}

/**
 * Refetch what a steering call changes: the moments, the clips and the run
 * itself. A clip's layout (`use-clip-layout.ts`) settles the same way.
 */
export function useSettle(): (runId: string) => void {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return (runId) => {
    if (workspaceId === null) return;
    for (const queryKey of [
      queryKeys.repurposeCandidates(workspaceId, runId),
      queryKeys.repurposeClips(workspaceId, runId),
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    void queryClient.invalidateQueries({
      queryKey: queryKeys.repurposeRun(workspaceId, runId),
      exact: true,
    });
  };
}

/** Remove a moment and its clip; on Autopilot the best moment in reserve is cut in its place. */
export function useRemoveMoment(): UseMutationResult<SteeringResponse, Error, MomentRef> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(removeEndpoint, {
        params: { runId: input.runId, candidateId: input.candidateId },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

/** Bring a removed moment back, with its clip as it was. */
export function useRestoreMoment(): UseMutationResult<SteeringResponse, Error, MomentRef> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(restoreEndpoint, {
        params: { runId: input.runId, candidateId: input.candidateId },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

/** Move a moment's start and end; a moment with a clip is cut again from them. */
export function useAdjustMoment(): UseMutationResult<
  SteeringResponse,
  Error,
  MomentRef & { readonly startMs: number; readonly endMs: number }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(adjustEndpoint, {
        params: { runId: input.runId, candidateId: input.candidateId },
        body: { startMs: input.startMs, endMs: input.endMs },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}
