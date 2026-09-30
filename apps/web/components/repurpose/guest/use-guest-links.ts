"use client";

/**
 * Guest links (2026-10-05): the run page's calls - list a run's guest links,
 * make one, turn one off.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index - the way the review
 * calls are (`review/use-review.ts`). Every change is read back from the
 * server: visits, downloads and what a link shares are the server's to say.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, useApiClient, useWorkspaceId } from "@montaj/api-client";

export interface GuestLink {
  readonly id: string;
  readonly runId: string;
  readonly hint: string;
  readonly guestName: string | null;
  /** Every clip of the run, clips made later included. */
  readonly allClips: boolean;
  readonly clipIds: readonly string[];
  /** How many of the run's clips it shares now. */
  readonly clipCount: number;
  readonly includeDubs: boolean;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly status: "live" | "expired" | "revoked";
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly visits: number;
  readonly lastVisitAt: string | null;
  readonly downloads: number;
  readonly lastDownloadAt: string | null;
}

export interface CreatedGuestLink extends GuestLink {
  /** The link itself: shown once, never listed again. */
  readonly url: string;
}

export interface CreateGuestLinkInput {
  readonly runId: string;
  readonly allClips: boolean;
  readonly clipIds: readonly string[];
  readonly guestName: string;
  readonly expiresInDays: number;
  readonly includeDubs: boolean;
}

const linksEndpoint = defineEndpoint<void, { readonly links: readonly GuestLink[] }>({
  method: "GET",
  path: "/repurpose/runs/{runId}/guest-links",
  auth: "bearer",
});

const createEndpoint = defineEndpoint<
  {
    readonly allClips: boolean;
    readonly clipIds: readonly string[];
    readonly guestName?: string;
    readonly expiresInDays: number;
    readonly includeDubs: boolean;
  },
  CreatedGuestLink
>({
  method: "POST",
  path: "/repurpose/runs/{runId}/guest-links",
  auth: "bearer",
});

const revokeEndpoint = defineEndpoint<void, GuestLink>({
  method: "DELETE",
  path: "/repurpose/runs/{runId}/guest-links/{linkId}",
  auth: "bearer",
});

export const guestLinkKeys = {
  links: (workspaceId: string, runId: string) => ["guest-links", workspaceId, runId] as const,
};

export function useGuestLinks(
  runId: string,
  enabled: boolean,
): UseQueryResult<{ readonly links: readonly GuestLink[] }> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: guestLinkKeys.links(workspaceId ?? "none", runId),
    enabled: enabled && workspaceId !== null,
    staleTime: 10_000,
    retry: false,
    queryFn: () => client.call(linksEndpoint, { params: { runId } }),
  });
}

export function useCreateGuestLink(): UseMutationResult<
  CreatedGuestLink,
  Error,
  CreateGuestLinkInput
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(createEndpoint, {
        params: { runId: input.runId },
        body: {
          allClips: input.allClips,
          clipIds: input.allClips ? [] : input.clipIds,
          expiresInDays: input.expiresInDays,
          includeDubs: input.includeDubs,
          ...(input.guestName.trim() === "" ? {} : { guestName: input.guestName.trim() }),
        },
      }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({
        queryKey: guestLinkKeys.links(workspaceId, input.runId),
      });
    },
  });
}

export function useRevokeGuestLink(): UseMutationResult<
  GuestLink,
  Error,
  { readonly runId: string; readonly linkId: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(revokeEndpoint, { params: { runId: input.runId, linkId: input.linkId } }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({
        queryKey: guestLinkKeys.links(workspaceId, input.runId),
      });
    },
  });
}
