"use client";

/**
 * Learn what works (2026-10-05): the pages' calls - a run's posts and their
 * numbers, "I posted this", typing numbers in, removing a pasted link, and
 * the workspace's "What works".
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, which
 * its contract test holds to the regenerated OpenAPI index - the way the
 * publishing calls are (`publishing/use-publishing.ts`). Every answer is read
 * back from the server after a change.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { defineEndpoint, isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";

/** The rollout flag; the API answers 404 (the run's list `enabled: false`) while it is off. */
export const PERFORMANCE_FLAG = "repurpose_performance";

export type PostPlatform =
  "youtube" | "instagram" | "tiktok" | "linkedin" | "x" | "facebook" | "threads";

export type MetricSource = "postiz" | "youtube_page" | "person";
export type Metric = "views" | "likes" | "comments" | "shares";
export const METRICS: readonly Metric[] = ["views", "likes", "comments", "shares"];

export interface MetricView {
  readonly value: number;
  readonly source: MetricSource;
  /** Read by Aksharo, not typed in by a person. */
  readonly measured: boolean;
  readonly at: string;
}

export type ReadingState = "reading" | "done" | "stopped" | "manual";

export interface ClipPost {
  readonly id: string;
  readonly runId: string;
  readonly clipId: string;
  readonly platform: PostPlatform;
  readonly platformLabel: string;
  readonly shape: string;
  readonly language: string | null;
  readonly source: "postiz" | "link";
  readonly url: string | null;
  readonly postedAt: string | null;
  readonly numbers: Readonly<Record<Metric, MetricView | null>>;
  readonly engagementRate: number | null;
  readonly reading: {
    readonly state: ReadingState;
    readonly nextAt: string | null;
    readonly note: string | null;
  };
  readonly canRemove: boolean;
  readonly createdAt: string;
}

export interface RunPerformance {
  readonly runId: string;
  readonly enabled: boolean;
  /** Whether this server reads numbers by itself at all; false, they can only be typed in. */
  readonly readsEnabled: boolean;
  readonly posts: readonly ClipPost[];
  readonly clips: readonly {
    readonly clipId: string;
    readonly shapes: readonly string[];
    readonly languages: readonly string[];
  }[];
}

export interface AddPostRequest {
  readonly url: string;
  readonly shape?: string;
  readonly language?: string;
  readonly postedAt?: string;
}

export type NumbersRequest = Partial<Record<Metric, number>>;

export interface GroupView {
  readonly key: string;
  readonly label: string;
  readonly posts: number;
  readonly medianRelative: number | null;
  readonly medianEngagement: number | null;
}

export interface FindingView {
  readonly dimension: string;
  readonly key: string;
  readonly label: string;
  readonly lift: number;
  readonly posts: number;
  readonly restPosts: number;
  readonly sentence: string;
}

export interface DimensionView {
  readonly key: string;
  readonly label: string;
  readonly groups: readonly GroupView[];
  readonly finding: FindingView | null;
  readonly note: string | null;
}

export interface TopClipView {
  readonly clipId: string;
  readonly runId: string;
  readonly title: string;
  readonly views: number;
  readonly engagementRate: number | null;
  readonly bestRelative: number | null;
  readonly posts: readonly {
    readonly postId: string;
    readonly platform: PostPlatform;
    readonly views: number | null;
    readonly url: string | null;
  }[];
}

export interface WhatWorks {
  readonly enabled: true;
  readonly days: number;
  readonly timeZone: string;
  readonly generatedAt: string;
  readonly totals: {
    readonly posts: number;
    readonly withViews: number;
    readonly measured: number;
    readonly entered: number;
    readonly clips: number;
  };
  readonly enough: boolean;
  readonly thresholds: {
    readonly minPosts: number;
    readonly minGroup: number;
    readonly clearLift: number;
    readonly steeringMinPosts: number;
  };
  readonly platforms: readonly {
    readonly platform: PostPlatform;
    readonly posts: number;
    readonly medianViews: number;
  }[];
  readonly topByViews: readonly TopClipView[];
  readonly topByEngagement: readonly TopClipView[];
  readonly dimensions: readonly DimensionView[];
  readonly findings: readonly FindingView[];
  readonly steering: { readonly basis: number; readonly lines: readonly string[] } | null;
}

const runEndpoint = defineEndpoint<void, RunPerformance>({
  method: "GET",
  path: "/repurpose/runs/{runId}/performance",
  auth: "bearer",
});

const addEndpoint = defineEndpoint<AddPostRequest, ClipPost>({
  method: "POST",
  path: "/repurpose/runs/{runId}/clips/{clipId}/performance/posts",
  auth: "bearer",
});

const removeEndpoint = defineEndpoint<void, { readonly removed: true }>({
  method: "DELETE",
  path: "/repurpose/runs/{runId}/performance/posts/{postId}",
  auth: "bearer",
});

const numbersEndpoint = defineEndpoint<NumbersRequest, ClipPost>({
  method: "POST",
  path: "/repurpose/runs/{runId}/performance/posts/{postId}/numbers",
  auth: "bearer",
});

const whatWorksEndpoint = defineEndpoint<void, WhatWorks>({
  method: "GET",
  path: "/repurpose/performance/what-works",
  auth: "bearer",
});

export const performanceKeys = {
  all: (workspaceId: string) => ["performance", workspaceId] as const,
  run: (workspaceId: string, runId: string) => ["performance", workspaceId, "run", runId] as const,
  whatWorks: (workspaceId: string, days: number) =>
    ["performance", workspaceId, "what-works", days] as const,
};

/** A route this API does not have (an older deployment, or the feature off) reads as off. */
function missingRoute(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 501);
}

function off(runId: string): RunPerformance {
  return { runId, enabled: false, readsEnabled: false, posts: [], clips: [] };
}

/** How soon to ask again: while a post's numbers are being read, now and then. */
export function performancePollDelay(posts: readonly ClipPost[]): number | false {
  return posts.some((post) => post.reading.state === "reading") ? 5 * 60_000 : false;
}

/** Every post of a run; each clip's card picks out its own. One request for the page. */
export function useRunPerformance(runId: string, enabled: boolean): UseQueryResult<RunPerformance> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: performanceKeys.run(workspaceId ?? "none", runId),
    enabled: enabled && workspaceId !== null,
    staleTime: 30_000,
    retry: false,
    // Only while this server reads numbers by itself: otherwise nothing changes by itself.
    refetchInterval: (query) =>
      query.state.data?.readsEnabled === true
        ? performancePollDelay(query.state.data.posts)
        : false,
    queryFn: async () => {
      try {
        return await client.call(runEndpoint, { params: { runId } });
      } catch (error) {
        if (missingRoute(error)) return off(runId);
        throw error;
      }
    },
  });
}

/** Refetch what a change touches: the run's posts, and What works. */
function useSettle(): (runId: string) => void {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return (runId) => {
    if (workspaceId === null) return;
    void queryClient.invalidateQueries({ queryKey: performanceKeys.run(workspaceId, runId) });
    void queryClient.invalidateQueries({
      queryKey: ["performance", workspaceId, "what-works"],
    });
  };
}

export function useAddPost(): UseMutationResult<
  ClipPost,
  Error,
  { readonly runId: string; readonly clipId: string; readonly body: AddPostRequest }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(addEndpoint, {
        params: { runId: input.runId, clipId: input.clipId },
        body: input.body,
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

export function useRemovePost(): UseMutationResult<
  { readonly removed: true },
  Error,
  { readonly runId: string; readonly postId: string }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(removeEndpoint, { params: { runId: input.runId, postId: input.postId } }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

export function useEnterNumbers(): UseMutationResult<
  ClipPost,
  Error,
  { readonly runId: string; readonly postId: string; readonly body: NumbersRequest }
> {
  const client = useApiClient();
  const settle = useSettle();
  return useMutation({
    mutationFn: (input) =>
      client.call(numbersEndpoint, {
        params: { runId: input.runId, postId: input.postId },
        body: input.body,
      }),
    onSettled: (_data, _error, input) => {
      settle(input.runId);
    },
  });
}

/** The workspace's What works, over `days`. */
export function useWhatWorks(days: number, enabled: boolean): UseQueryResult<WhatWorks> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: performanceKeys.whatWorks(workspaceId ?? "none", days),
    enabled: enabled && workspaceId !== null,
    staleTime: 60_000,
    retry: false,
    queryFn: () => client.call(whatWorksEndpoint, { query: { days: String(days) } }),
  });
}
