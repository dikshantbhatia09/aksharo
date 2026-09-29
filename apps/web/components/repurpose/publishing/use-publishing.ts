"use client";

/**
 * Posting a run's clips to social accounts (2026-09-29): the page's calls.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index - the same way the
 * steering calls are (`use-steering.ts`). Every answer is read back from the
 * server after a change: which posts exist, and where each one stands, is the
 * server's to say.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";

export type PublishProvider =
  "instagram" | "facebook" | "youtube" | "tiktok" | "linkedin" | "x" | "threads";

export type VideoShape = "9:16" | "4:5" | "1:1" | "16:9";

export type UnavailableReason =
  | "flag_off"
  | "not_this_workspace"
  | "not_configured"
  | "unreachable"
  | "key_refused"
  | "no_channels";

export interface PublishingStatus {
  /** The feature is on for this workspace: the page offers posting at all. */
  readonly enabled: boolean;
  /** Posting would work right now. */
  readonly available: boolean;
  readonly reason: UnavailableReason | null;
  readonly message: string | null;
  /** Where to open Postiz, for a workspace allowed to use it. */
  readonly postizUrl: string | null;
  readonly channelCount: number;
}

export interface PublishChannel {
  readonly id: string | null;
  readonly provider: PublishProvider | null;
  readonly platform: string;
  readonly name: string;
  readonly username: string | null;
  readonly avatarUrl: string | null;
  readonly supported: boolean;
  readonly disabled: boolean;
  readonly note: string | null;
}

export interface PlanChannel extends PublishChannel {
  readonly surface: string;
  readonly shape: VideoShape | null;
  readonly ready: boolean;
}

export interface PlanText {
  readonly title: string | null;
  readonly body: string;
  readonly bodyLimit: number;
  readonly titleLimit: number | null;
  readonly titleRequired: boolean;
  readonly linkLength: number | null;
}

export interface PublishPlan {
  readonly status: PublishingStatus;
  readonly clip: {
    readonly id: string;
    readonly title: string;
    readonly durationMs: number | null;
  };
  readonly channels: readonly PlanChannel[];
  readonly texts: Partial<Record<PublishProvider, PlanText>>;
  readonly visibility: { readonly youtube: "public"; readonly tiktok: "private" };
  readonly defaults: { readonly timezone: string; readonly dailyTime: string };
  readonly nextDaily: Readonly<Record<string, string>>;
  /**
   * Clip review (2026-10-03): whether the workspace needs approval before
   * posting and whether this clip has it. Absent from an older API.
   */
  readonly approval?: {
    readonly required: boolean;
    readonly approved: boolean;
    readonly message: string | null;
  };
}

export type PostStatus = "posting" | "scheduled" | "posted" | "failed" | "cancelled";

export interface PublishPost {
  readonly id: string;
  readonly clipId: string;
  readonly runId: string;
  readonly channel: {
    readonly id: string;
    readonly name: string;
    readonly avatarUrl: string | null;
  } | null;
  readonly provider: string;
  readonly platform: string;
  readonly shape: VideoShape | null;
  readonly status: PostStatus;
  readonly state: string;
  readonly scheduledAt: string | null;
  readonly publishedAt: string | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly text: string;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly note: string | null;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly createdAt: string;
}

export type PublishWhen =
  | { readonly kind: "now" }
  | { readonly kind: "at"; readonly at: string; readonly timezone?: string }
  | { readonly kind: "daily"; readonly time?: string; readonly timezone?: string };

export interface PublishVisibility {
  readonly youtube?: "public" | "unlisted" | "private";
  readonly tiktok?: "public" | "friends" | "private";
}

export interface PublishRequest {
  readonly channelIds: readonly string[];
  readonly texts?: Partial<
    Record<PublishProvider, { readonly title?: string; readonly body: string }>
  >;
  readonly visibility?: PublishVisibility;
  readonly when: PublishWhen;
  readonly again?: boolean;
}

export interface PublishResult {
  readonly batchId: string;
  readonly posts: readonly PublishPost[];
}

export interface DailyRequest {
  readonly clipIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly time?: string;
  readonly timezone?: string;
  readonly visibility?: PublishVisibility;
}

export interface DailyResult extends PublishResult {
  readonly skipped: readonly {
    readonly clipId: string;
    readonly channelId: string;
    readonly reason: string;
  }[];
}

const statusEndpoint = defineEndpoint<void, PublishingStatus>({
  method: "GET",
  path: "/publishing/status",
  auth: "bearer",
});

const channelsEndpoint = defineEndpoint<
  void,
  { readonly status: PublishingStatus; readonly channels: readonly PublishChannel[] }
>({
  method: "GET",
  path: "/publishing/channels",
  auth: "bearer",
});

const planEndpoint = defineEndpoint<void, PublishPlan>({
  method: "GET",
  path: "/repurpose/runs/{runId}/clips/{clipId}/publish-plan",
  auth: "bearer",
});

const publishEndpoint = defineEndpoint<PublishRequest, PublishResult>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/posts",
  auth: "bearer",
});

const postsEndpoint = defineEndpoint<void, { readonly posts: readonly PublishPost[] }>({
  method: "GET",
  path: "/repurpose/runs/{runId}/posts",
  auth: "bearer",
});

const dailyEndpoint = defineEndpoint<DailyRequest, DailyResult>({
  method: "POST",
  path: "/repurpose/runs/{runId}/posts/daily",
  auth: "bearer",
});

const cancelEndpoint = defineEndpoint<void, PublishPost>({
  method: "DELETE",
  path: "/publishing/posts/{postId}",
  auth: "bearer",
});

const retryEndpoint = defineEndpoint<void, PublishPost>({
  method: "POST",
  path: "/publishing/posts/{postId}/retry",
  auth: "bearer",
});

export const publishingKeys = {
  all: (workspaceId: string) => ["publishing", workspaceId] as const,
  status: (workspaceId: string) => ["publishing", workspaceId, "status"] as const,
  channels: (workspaceId: string) => ["publishing", workspaceId, "channels"] as const,
  plan: (workspaceId: string, runId: string, clipId: string) =>
    ["publishing", workspaceId, "plan", runId, clipId] as const,
  posts: (workspaceId: string, runId: string) =>
    ["publishing", workspaceId, "posts", runId] as const,
};

/** A route this API does not have yet (older deployment) reads as "off", not as an error. */
function missingRoute(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501);
}

const OFF: PublishingStatus = {
  enabled: false,
  available: false,
  reason: "flag_off",
  message: null,
  postizUrl: null,
  channelCount: 0,
};

/**
 * Whether this workspace posts at all, and what is missing if it cannot yet.
 * While it loads, or on an API without the route, it reads as off: no Post
 * button appears for a feature that is not there.
 */
export function usePublishingStatus(): {
  readonly status: PublishingStatus;
  readonly loading: boolean;
} {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  const query = useQuery({
    queryKey: publishingKeys.status(workspaceId ?? "none"),
    enabled: workspaceId !== null,
    staleTime: 60_000,
    retry: (count, error) => !missingRoute(error) && count < 1,
    queryFn: async () => {
      try {
        return await client.call(statusEndpoint);
      } catch (error) {
        if (missingRoute(error)) return OFF;
        throw error;
      }
    },
  });
  return { status: query.data ?? OFF, loading: query.isLoading };
}

export function usePublishingChannels(enabled: boolean): UseQueryResult<{
  readonly status: PublishingStatus;
  readonly channels: readonly PublishChannel[];
}> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: publishingKeys.channels(workspaceId ?? "none"),
    enabled: enabled && workspaceId !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: () => client.call(channelsEndpoint),
  });
}

/** What posting one clip would do. Fetched fresh each time the dialog opens. */
export function usePublishPlan(
  runId: string,
  clipId: string,
  open: boolean,
): UseQueryResult<PublishPlan> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: publishingKeys.plan(workspaceId ?? "none", runId, clipId),
    enabled: open && workspaceId !== null,
    staleTime: 0,
    retry: false,
    queryFn: () => client.call(planEndpoint, { params: { runId, clipId } }),
  });
}

/** How soon to ask again: quickly while a post is going out, now and then while one waits. */
export function postsPollDelay(posts: readonly PublishPost[]): number | false {
  if (posts.some((post) => post.status === "posting")) return 5_000;
  if (posts.some((post) => post.status === "scheduled")) return 60_000;
  return false;
}

/** Every post of a run; each clip's card picks out its own. One request for the page. */
export function useRunPosts(
  runId: string,
  enabled: boolean,
): UseQueryResult<{ readonly posts: readonly PublishPost[] }> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: publishingKeys.posts(workspaceId ?? "none", runId),
    enabled: enabled && workspaceId !== null,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (query) => postsPollDelay(query.state.data?.posts ?? []),
    queryFn: () => client.call(postsEndpoint, { params: { runId } }),
  });
}

/** Refetch what a change touches: the run's posts, and plans that show next free days. */
function useSettle(): (runId: string) => void {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return (runId) => {
    if (workspaceId === null) return;
    void queryClient.invalidateQueries({ queryKey: publishingKeys.posts(workspaceId, runId) });
    void queryClient.invalidateQueries({
      queryKey: ["publishing", workspaceId, "plan", runId],
    });
  };
}

/**
 * Post one clip. `idempotencyKey` is kept by the caller for one confirmation,
 * so pressing again after a lost answer replays the first answer instead of
 * planning a second post.
 */
export function usePublishClip(): UseMutationResult<
  PublishResult,
  Error,
  {
    readonly runId: string;
    readonly clipId: string;
    readonly body: PublishRequest;
    readonly idempotencyKey: string;
  }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(publishEndpoint, {
        params: { runId: input.runId, clipId: input.clipId },
        body: input.body,
        headers: { "Idempotency-Key": input.idempotencyKey },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

/** "Post one a day" for several clips at once. */
export function useDailyPosts(): UseMutationResult<
  DailyResult,
  Error,
  { readonly runId: string; readonly body: DailyRequest; readonly idempotencyKey: string }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(dailyEndpoint, {
        params: { runId: input.runId },
        body: input.body,
        headers: { "Idempotency-Key": input.idempotencyKey },
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

export function useCancelPost(): UseMutationResult<
  PublishPost,
  Error,
  { readonly runId: string; readonly postId: string }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) => client.call(cancelEndpoint, { params: { postId: input.postId } }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

export function useRetryPost(): UseMutationResult<
  PublishPost,
  Error,
  { readonly runId: string; readonly postId: string }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) => client.call(retryEndpoint, { params: { postId: input.postId } }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

/** A fresh key for one confirmation. */
export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${String(Date.now())}-${Math.random().toString(36).slice(2)}`;
}
