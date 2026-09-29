"use client";

/**
 * Channel automations and several links at once (2026-10-02): the pages' calls.
 *
 * Described here rather than in `@montaj/api-client`'s `endpoints.ts`, like the
 * steering and publishing calls (`use-steering.ts`, `use-publishing.ts`): the
 * contract test there holds that file to the regenerated OpenAPI index, and
 * these routes are new. What a watch is doing is the server's to say; every
 * change is read back from its answer.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import {
  defineEndpoint,
  isApiError,
  queryKeys,
  useApiClient,
  useWorkspaceId,
  type CreateRepurposeRunRequest,
} from "@montaj/api-client";

/**
 * The rollout flag for channel automations and several links at once. The API
 * answers 404 while it is off (a missing flag row is off), so the pages only
 * offer what it would accept.
 */
export const AUTOMATIONS_FLAG = "repurpose_automations";

export type RunSetupRequest = CreateRepurposeRunRequest["setup"];

export type WatchState = "active" | "paused" | "error";
export type WatchStateReason =
  | "person"
  | "no_credits"
  | "creator_left"
  | "style_unknown"
  | "setup_invalid"
  | "channel_not_found";
export type WatchVideoState = "pending" | "starting" | "started" | "skipped" | "failed";

export interface WatchVideo {
  readonly videoId: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly state: WatchVideoState;
  readonly reason: string | null;
  readonly backfill: boolean;
  readonly runId: string | null;
  readonly runStatus: string | null;
}

export interface Watch {
  readonly id: string;
  readonly kind: "youtube_channel";
  readonly channelId: string;
  readonly channelUrl: string;
  readonly title: string;
  readonly handle: string | null;
  readonly state: WatchState;
  readonly stateReason: WatchStateReason | null;
  readonly message: string | null;
  readonly setup: RunSetupRequest;
  readonly backfillCount: number;
  readonly lastCheckedAt: string | null;
  readonly nextCheckAt: string | null;
  readonly lastErrorCode: string | null;
  readonly runsStarted: number;
  readonly videos: readonly WatchVideo[];
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WatchList {
  readonly items: readonly Watch[];
  /** False: this server reads no feeds right now, so nothing new starts. */
  readonly checksEnabled: boolean;
  readonly maxWatches: number;
}

export interface ResolvedChannel {
  readonly channelId: string;
  readonly title: string;
  readonly handle: string | null;
  readonly channelUrl: string;
  /** This workspace's automation of the channel, when it already has one. */
  readonly watchId: string | null;
}

export interface CreateWatchRequest {
  readonly url: string;
  readonly setup: RunSetupRequest;
  readonly backfill: number;
  readonly rightsAttested: true;
}

export type BulkOutcome = "started" | "already_running" | "duplicate" | "refused";

export interface BulkRunResult {
  readonly index: number;
  readonly link: string;
  readonly outcome: BulkOutcome;
  readonly runId: string | null;
  readonly code: string | null;
  readonly message: string | null;
}

export interface BulkRunsRequest {
  readonly links: readonly string[];
  readonly setup: RunSetupRequest;
  readonly rightsAttested: true;
}

export interface BulkRunsResponse {
  readonly results: readonly BulkRunResult[];
  readonly started: number;
}

const listEndpoint = defineEndpoint<void, WatchList>({
  method: "GET",
  path: "/repurpose/watches",
  auth: "bearer",
});

const resolveEndpoint = defineEndpoint<{ url: string }, ResolvedChannel>({
  method: "POST",
  path: "/repurpose/watches/resolve",
  auth: "bearer",
});

const createEndpoint = defineEndpoint<CreateWatchRequest, Watch>({
  method: "POST",
  path: "/repurpose/watches",
  auth: "bearer",
});

const updateEndpoint = defineEndpoint<{ setup: RunSetupRequest }, Watch>({
  method: "PATCH",
  path: "/repurpose/watches/{watchId}",
  auth: "bearer",
});

const pauseEndpoint = defineEndpoint<void, Watch>({
  method: "POST",
  path: "/repurpose/watches/{watchId}/pause",
  auth: "bearer",
});

const resumeEndpoint = defineEndpoint<void, Watch>({
  method: "POST",
  path: "/repurpose/watches/{watchId}/resume",
  auth: "bearer",
});

const removeEndpoint = defineEndpoint<void, { id: string }>({
  method: "DELETE",
  path: "/repurpose/watches/{watchId}",
  auth: "bearer",
});

const bulkEndpoint = defineEndpoint<BulkRunsRequest, BulkRunsResponse>({
  method: "POST",
  path: "/repurpose/runs/bulk",
  auth: "bearer",
});

/** Under the repurpose scope, so a run's realtime news refreshes it too. */
function watchesKey(workspaceId: string): readonly unknown[] {
  return [...queryKeys.repurposeScope(workspaceId), "watches"];
}

/**
 * This workspace's automations. Re-read every minute while the page is open:
 * a check runs every quarter of an hour, and a run it started moves on its
 * own. A 404 (the feature is off here) is an answer, not an error to retry.
 */
export function useWatches(enabled = true): UseQueryResult<WatchList> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: watchesKey(workspaceId ?? "none"),
    enabled: enabled && workspaceId !== null,
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
    refetchInterval: 60_000,
    queryFn: () => client.call(listEndpoint),
  });
}

/** Refresh the list after a change, from the change's own answer. */
function useWatchChange<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
): UseMutationResult<TResult, Error, TInput> {
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: run,
    onSettled: () => {
      if (workspaceId !== null) {
        void queryClient.invalidateQueries({ queryKey: watchesKey(workspaceId) });
      }
    },
  });
}

/** Which channel a link is, for the preview. Reads YouTube; the answer is cached server-side. */
export function useResolveChannel(): UseMutationResult<ResolvedChannel, Error, string> {
  const client = useApiClient();
  return useMutation({
    mutationFn: (url: string) => client.call(resolveEndpoint, { body: { url } }),
  });
}

export function useCreateWatch(): UseMutationResult<Watch, Error, CreateWatchRequest> {
  const client = useApiClient();
  return useWatchChange((body: CreateWatchRequest) => client.call(createEndpoint, { body }));
}

export function useUpdateWatch(): UseMutationResult<
  Watch,
  Error,
  { readonly watchId: string; readonly setup: RunSetupRequest }
> {
  const client = useApiClient();
  return useWatchChange((input: { readonly watchId: string; readonly setup: RunSetupRequest }) =>
    client.call(updateEndpoint, {
      params: { watchId: input.watchId },
      body: { setup: input.setup },
    }),
  );
}

export function usePauseWatch(): UseMutationResult<Watch, Error, string> {
  const client = useApiClient();
  return useWatchChange((watchId: string) => client.call(pauseEndpoint, { params: { watchId } }));
}

export function useResumeWatch(): UseMutationResult<Watch, Error, string> {
  const client = useApiClient();
  return useWatchChange((watchId: string) => client.call(resumeEndpoint, { params: { watchId } }));
}

export function useRemoveWatch(): UseMutationResult<{ id: string }, Error, string> {
  const client = useApiClient();
  return useWatchChange((watchId: string) => client.call(removeEndpoint, { params: { watchId } }));
}

/**
 * Several links at once: one run per link, one answer per line. The key is the
 * caller's, per request body, so a double press replays the first answer.
 */
export function useBulkRuns(): UseMutationResult<
  BulkRunsResponse,
  Error,
  { readonly body: BulkRunsRequest; readonly idempotencyKey: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(bulkEndpoint, {
        body: input.body,
        headers: { "Idempotency-Key": input.idempotencyKey },
      }),
    onSuccess: () => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.repurposeRuns(workspaceId) });
    },
  });
}
