"use client";

/**
 * Clip review (2026-10-03): the run page's calls - each clip's review state,
 * approving and asking for changes, comments, and the client review links.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index - the same way the
 * steering and posting calls are (`use-steering.ts`, `use-publishing.ts`).
 * Every change is read back from the server: who decided, which videos it
 * covers and whether a clip is back in review are the server's to say.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";

export type ReviewState = "pending" | "approved" | "changes_requested";
export type ReviewDecision = Exclude<ReviewState, "pending">;
export type ReviewShape = "9:16" | "4:5" | "1:1" | "16:9";
export type VideoPins = Readonly<Partial<Record<ReviewShape, string>>>;

export interface ReviewActor {
  readonly kind: "member" | "client" | "system";
  readonly name: string | null;
  readonly userId: string | null;
  readonly link: {
    readonly id: string;
    readonly hint: string;
    readonly label: string | null;
  } | null;
}

export interface ReviewPermissions {
  readonly approve: boolean;
  readonly requestChanges: boolean;
  readonly comment: boolean;
  readonly resolveAny: boolean;
  readonly shareLinks: boolean;
  readonly revokeLinks: boolean;
}

export interface ClipReviewSummary {
  readonly clipId: string;
  readonly state: ReviewState;
  readonly decidedBy: ReviewActor | null;
  readonly decidedAt: string | null;
  /** `video_changed` when Aksharo put it back in review. */
  readonly reason: string | null;
  readonly covered: readonly ReviewShape[];
  readonly uncovered: readonly ReviewShape[];
  /** The videos a decision now would be made on: sent back as `expect`. */
  readonly videos: VideoPins;
  readonly video: {
    readonly shape: ReviewShape;
    readonly exportId: string;
    readonly url: string | null;
    readonly durationMs: number | null;
  } | null;
  readonly comments: { readonly total: number; readonly open: number };
}

export interface RunReview {
  readonly runId: string;
  readonly needsApproval: boolean;
  readonly permissions: ReviewPermissions;
  readonly clips: readonly ClipReviewSummary[];
}

export interface ClipComment {
  readonly id: string;
  readonly clipId: string;
  readonly author: ReviewActor;
  readonly body: string;
  readonly atMs: number | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
  readonly canResolve: boolean;
}

export interface ClipReviewEvent {
  readonly id: string;
  readonly state: ReviewState;
  readonly actor: ReviewActor;
  readonly note: string | null;
  readonly reason: string | null;
  readonly shapes: readonly ReviewShape[];
  readonly createdAt: string;
}

export interface ClipReviewDetail {
  readonly clip: ClipReviewSummary;
  readonly events: readonly ClipReviewEvent[];
  readonly comments: readonly ClipComment[];
}

export interface ReviewLink {
  readonly id: string;
  readonly runId: string;
  readonly hint: string;
  readonly label: string | null;
  readonly requireName: boolean;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly status: "live" | "expired" | "revoked";
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly visits: number;
  readonly lastVisitAt: string | null;
  readonly decisions: number;
  readonly comments: number;
}

export interface CreatedReviewLink extends ReviewLink {
  /** The link itself: shown once, never listed again. */
  readonly url: string;
}

const runReviewEndpoint = defineEndpoint<void, RunReview>({
  method: "GET",
  path: "/repurpose/runs/{runId}/review",
  auth: "bearer",
});

const clipReviewEndpoint = defineEndpoint<void, ClipReviewDetail>({
  method: "GET",
  path: "/repurpose/runs/{runId}/clips/{clipId}/review",
  auth: "bearer",
});

const decideEndpoint = defineEndpoint<
  { readonly decision: ReviewDecision; readonly note?: string; readonly expect?: VideoPins },
  ClipReviewSummary
>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/review",
  auth: "bearer",
});

const addCommentEndpoint = defineEndpoint<
  { readonly body: string; readonly atMs?: number },
  ClipComment
>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/comments",
  auth: "bearer",
});

const resolveCommentEndpoint = defineEndpoint<{ readonly resolved: boolean }, ClipComment>({
  method: "PATCH",
  path: "/repurpose/runs/{runId}/clips/{clipId}/comments/{commentId}",
  auth: "bearer",
});

const linksEndpoint = defineEndpoint<void, { readonly links: readonly ReviewLink[] }>({
  method: "GET",
  path: "/repurpose/runs/{runId}/review-links",
  auth: "bearer",
});

const createLinkEndpoint = defineEndpoint<
  { readonly expiresInDays: number; readonly requireName: boolean; readonly label?: string },
  CreatedReviewLink
>({
  method: "POST",
  path: "/repurpose/runs/{runId}/review-links",
  auth: "bearer",
});

const revokeLinkEndpoint = defineEndpoint<void, ReviewLink>({
  method: "DELETE",
  path: "/repurpose/runs/{runId}/review-links/{linkId}",
  auth: "bearer",
});

export const reviewKeys = {
  all: (workspaceId: string) => ["review", workspaceId] as const,
  run: (workspaceId: string, runId: string) => ["review", workspaceId, "run", runId] as const,
  clip: (workspaceId: string, runId: string, clipId: string) =>
    ["review", workspaceId, "clip", runId, clipId] as const,
  links: (workspaceId: string, runId: string) => ["review", workspaceId, "links", runId] as const,
};

/** A route this API does not have yet (an older deployment) reads as "no review", not an error. */
function missingRoute(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501);
}

/**
 * Every clip's review on a run, polled while the page is open: a client may
 * decide on their phone while the team watches the run.
 */
export function useRunReview(runId: string, enabled = true): UseQueryResult<RunReview | null> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: reviewKeys.run(workspaceId ?? "none", runId),
    enabled: enabled && workspaceId !== null,
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: (count, error) => !missingRoute(error) && count < 1,
    queryFn: async () => {
      try {
        return await client.call(runReviewEndpoint, { params: { runId } });
      } catch (error) {
        if (missingRoute(error)) return null;
        throw error;
      }
    },
  });
}

/** One clip's history and comments, while its thread is open. */
export function useClipReview(
  runId: string,
  clipId: string,
  enabled: boolean,
): UseQueryResult<ClipReviewDetail> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: reviewKeys.clip(workspaceId ?? "none", runId, clipId),
    enabled: enabled && workspaceId !== null,
    staleTime: 5_000,
    refetchInterval: enabled ? 30_000 : false,
    retry: false,
    queryFn: () => client.call(clipReviewEndpoint, { params: { runId, clipId } }),
  });
}

/**
 * Refetch what a review change touches: the run's review, the clip's thread,
 * and posting (a clip's approval decides whether it can be posted).
 */
function useSettle(): (runId: string, clipId?: string) => void {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return (runId, clipId) => {
    if (workspaceId === null) return;
    void queryClient.invalidateQueries({ queryKey: reviewKeys.run(workspaceId, runId) });
    if (clipId !== undefined) {
      void queryClient.invalidateQueries({ queryKey: reviewKeys.clip(workspaceId, runId, clipId) });
    }
    void queryClient.invalidateQueries({ queryKey: ["publishing", workspaceId, "plan", runId] });
  };
}

export function useDecideClip(): UseMutationResult<
  ClipReviewSummary,
  Error,
  {
    readonly runId: string;
    readonly clipId: string;
    readonly decision: ReviewDecision;
    readonly note?: string;
    readonly expect?: VideoPins;
  }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(decideEndpoint, {
        params: { runId: input.runId, clipId: input.clipId },
        body: {
          decision: input.decision,
          ...(input.note === undefined || input.note.trim() === "" ? {} : { note: input.note }),
          ...(input.expect === undefined ? {} : { expect: input.expect }),
        },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId, input.clipId);
    },
  });
}

export function useAddClipComment(): UseMutationResult<
  ClipComment,
  Error,
  { readonly runId: string; readonly clipId: string; readonly body: string; readonly atMs?: number }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(addCommentEndpoint, {
        params: { runId: input.runId, clipId: input.clipId },
        body: { body: input.body, ...(input.atMs === undefined ? {} : { atMs: input.atMs }) },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId, input.clipId);
    },
  });
}

export function useResolveClipComment(): UseMutationResult<
  ClipComment,
  Error,
  {
    readonly runId: string;
    readonly clipId: string;
    readonly commentId: string;
    readonly resolved: boolean;
  }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(resolveCommentEndpoint, {
        params: { runId: input.runId, clipId: input.clipId, commentId: input.commentId },
        body: { resolved: input.resolved },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId, input.clipId);
    },
  });
}

export function useReviewLinks(
  runId: string,
  enabled: boolean,
): UseQueryResult<{ readonly links: readonly ReviewLink[] }> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: reviewKeys.links(workspaceId ?? "none", runId),
    enabled: enabled && workspaceId !== null,
    staleTime: 10_000,
    retry: false,
    queryFn: () => client.call(linksEndpoint, { params: { runId } }),
  });
}

export function useCreateReviewLink(): UseMutationResult<
  CreatedReviewLink,
  Error,
  {
    readonly runId: string;
    readonly expiresInDays: number;
    readonly requireName: boolean;
    readonly label?: string;
  }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(createLinkEndpoint, {
        params: { runId: input.runId },
        body: {
          expiresInDays: input.expiresInDays,
          requireName: input.requireName,
          ...(input.label === undefined || input.label.trim() === ""
            ? {}
            : { label: input.label.trim() }),
        },
      }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: reviewKeys.links(workspaceId, input.runId) });
    },
  });
}

export function useRevokeReviewLink(): UseMutationResult<
  ReviewLink,
  Error,
  { readonly runId: string; readonly linkId: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(revokeLinkEndpoint, { params: { runId: input.runId, linkId: input.linkId } }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: reviewKeys.links(workspaceId, input.runId) });
    },
  });
}

// ---------------------------------------------------------------------------
// The workspace setting: "Clips need approval before posting"
// ---------------------------------------------------------------------------

/** The slice of `GET /workspaces/{id}` the setting needs. */
export interface WorkspaceApprovalView {
  readonly id: string;
  readonly role: "owner" | "admin" | "editor" | "viewer";
  readonly settings: { readonly clipsNeedApproval?: boolean };
}

const workspaceEndpoint = defineEndpoint<void, WorkspaceApprovalView>({
  method: "GET",
  path: "/workspaces/{id}",
  auth: "bearer",
});

const updateWorkspaceEndpoint = defineEndpoint<
  { readonly settings: { readonly clipsNeedApproval: boolean } },
  WorkspaceApprovalView
>({
  method: "PATCH",
  path: "/workspaces/{id}",
  auth: "bearer",
});

const workspaceKey = (workspaceId: string) => ["review", workspaceId, "workspace"] as const;

/**
 * Whether clips need approval before posting, and whether this person may
 * change it (owners and admins; the API's `PATCH /workspaces/{id}` holds the
 * same rule and audits the change).
 */
export function useApprovalSetting(): UseQueryResult<{
  readonly on: boolean;
  readonly canChange: boolean;
}> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: workspaceKey(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const workspace = await client.call(workspaceEndpoint, {
        params: { id: workspaceId ?? "" },
      });
      return {
        on: workspace.settings.clipsNeedApproval === true,
        canChange: workspace.role === "owner" || workspace.role === "admin",
      };
    },
  });
}

export function useSetApprovalSetting(): UseMutationResult<WorkspaceApprovalView, Error, boolean> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (on) =>
      client.call(updateWorkspaceEndpoint, {
        params: { id: workspaceId ?? "" },
        body: { settings: { clipsNeedApproval: on } },
      }),
    onSettled: () => {
      if (workspaceId === null) return;
      // The setting, every run's review ("needs approval"), and every Post dialog.
      void queryClient.invalidateQueries({ queryKey: reviewKeys.all(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: ["publishing", workspaceId] });
    },
  });
}
