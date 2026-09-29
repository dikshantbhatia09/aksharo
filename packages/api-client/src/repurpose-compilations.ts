/**
 * Compilations and series (2026-10-03): a run's clips joined into one video,
 * and consecutive clips labelled "Part N of M". The routes are described here,
 * ahead of the regenerated OpenAPI index, like the other clips routes
 * (`hooks.ts`, `repurpose-copy.ts`).
 *
 * `/repurpose/runs/{runId}/compilations` and `/repurpose/runs/{runId}/series`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { useApiClient, useWorkspaceId } from "./context.js";
import { isApiError } from "./errors.js";
import { defineEndpoint } from "./http.js";
import { queryKeys } from "./query-keys.js";

export type RepurposeCompilationShape = "9:16" | "4:5" | "1:1" | "16:9";

/**
 * One compilation. `expired`: made, and its file deleted since (renders are
 * kept seven days); `stale`: a clip's captioned video changed since it was
 * made. `canRetry` says "Make again" will be taken. `progress` is the render's
 * percent while it runs.
 */
export interface RepurposeCompilation {
  id: string;
  runId: string;
  shape: RepurposeCompilationShape;
  title: string | null;
  clipIds: string[];
  status: "waiting" | "rendering" | "ready" | "failed" | "expired";
  failureCode: string | null;
  durationMs: number | null;
  progress: number | null;
  playUrl: string | null;
  downloadUrl: string | null;
  expiresAt: string | null;
  stale: boolean;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRepurposeCompilationRequest {
  /** 2 to 20 clips, in playing order. */
  clipIds: string[];
  shape: RepurposeCompilationShape;
  /** The title card's words; leave it out for no card. */
  title?: string;
}

/** A series: its clips in part order, and how many of each clip's shapes carry their labels. */
export interface RepurposeSeries {
  id: string;
  runId: string;
  clipIds: string[];
  parts: Array<{ clipId: string; part: number; labelled: number; pending: number }>;
  createdAt: string;
}

const compilationsEndpoint = defineEndpoint<
  void,
  { runId: string; compilations: RepurposeCompilation[] }
>({ method: "GET", path: "/repurpose/runs/{runId}/compilations", auth: "bearer" });

const createCompilationEndpoint = defineEndpoint<
  CreateRepurposeCompilationRequest,
  RepurposeCompilation
>({ method: "POST", path: "/repurpose/runs/{runId}/compilations", auth: "bearer" });

const retryCompilationEndpoint = defineEndpoint<void, RepurposeCompilation>({
  method: "POST",
  path: "/repurpose/runs/{runId}/compilations/{compilationId}/retry",
  auth: "bearer",
});

const deleteCompilationEndpoint = defineEndpoint<void, { id: string }>({
  method: "DELETE",
  path: "/repurpose/runs/{runId}/compilations/{compilationId}",
  auth: "bearer",
});

const seriesEndpoint = defineEndpoint<void, { runId: string; series: RepurposeSeries[] }>({
  method: "GET",
  path: "/repurpose/runs/{runId}/series",
  auth: "bearer",
});

const createSeriesEndpoint = defineEndpoint<{ clipIds: string[] }, RepurposeSeries>({
  method: "POST",
  path: "/repurpose/runs/{runId}/series",
  auth: "bearer",
});

const deleteSeriesEndpoint = defineEndpoint<void, { id: string; restored: number }>({
  method: "DELETE",
  path: "/repurpose/runs/{runId}/series/{seriesId}",
  auth: "bearer",
});

/** Under the run's own key, so a run's realtime invalidation refreshes them too. */
export function compilationsQueryKey(workspaceId: string, runId: string) {
  return [...queryKeys.repurposeRun(workspaceId, runId), "compilations"] as const;
}

export function seriesQueryKey(workspaceId: string, runId: string) {
  return [...queryKeys.repurposeRun(workspaceId, runId), "series"] as const;
}

/** Every 5 s while one is waiting or being made. */
export const COMPILATIONS_POLL_MS = 5_000;
/** A settled list with files is read again well inside the hour its URLs are signed for. */
export const COMPILATIONS_URL_REFRESH_MS = 10 * 60_000;

export function compilationsPollDelay(
  compilations: readonly RepurposeCompilation[] | undefined,
): number | false {
  const list = compilations ?? [];
  if (list.some((entry) => entry.status === "waiting" || entry.status === "rendering")) {
    return COMPILATIONS_POLL_MS;
  }
  return list.some((entry) => entry.playUrl !== null) ? COMPILATIONS_URL_REFRESH_MS : false;
}

const noRetryOn4xx = (failureCount: number, error: Error): boolean =>
  !(isApiError(error) && error.status >= 400 && error.status < 500) && failureCount < 2;

/** A run's compilations, newest first, polled while one is being made. */
export function useRepurposeCompilations(
  runId: string | null,
): UseQueryResult<{ runId: string; compilations: RepurposeCompilation[] }> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: compilationsQueryKey(workspaceId ?? "none", runId ?? "none"),
    enabled: workspaceId !== null && runId !== null,
    retry: noRetryOn4xx,
    refetchInterval: (query) => compilationsPollDelay(query.state.data?.compilations),
    refetchOnWindowFocus: true,
    queryFn: () => client.call(compilationsEndpoint, { params: { runId: runId ?? "" } }),
  });
}

/** Puts one compilation into the cached list, newest first, replacing its older copy. */
export function cacheCompilation(
  queryClient: Pick<QueryClient, "setQueryData">,
  workspaceId: string,
  compilation: RepurposeCompilation,
): void {
  queryClient.setQueryData<{ runId: string; compilations: RepurposeCompilation[] }>(
    compilationsQueryKey(workspaceId, compilation.runId),
    (current) => ({
      runId: compilation.runId,
      compilations: [
        compilation,
        ...(current?.compilations ?? []).filter((entry) => entry.id !== compilation.id),
      ],
    }),
  );
}

/**
 * Make a compilation. Resolves with it (the one already made, when the same
 * clips, shape and title were asked for before). Rejects with 409
 * `repurpose/compilation_clips_not_ready` (`details.clipIds`) or 400
 * `repurpose/compilation_too_long`.
 */
export function useCreateCompilation(): UseMutationResult<
  RepurposeCompilation,
  Error,
  { readonly runId: string; readonly body: CreateRepurposeCompilationRequest }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(createCompilationEndpoint, { params: { runId: input.runId }, body: input.body }),
    onSuccess: (compilation) => {
      if (workspaceId !== null) cacheCompilation(queryClient, workspaceId, compilation);
    },
  });
}

/** Make one again: failed, expired, or its clips changed since. */
export function useRetryCompilation(): UseMutationResult<
  RepurposeCompilation,
  Error,
  { readonly runId: string; readonly compilationId: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(retryCompilationEndpoint, {
        params: { runId: input.runId, compilationId: input.compilationId },
      }),
    onSuccess: (compilation) => {
      if (workspaceId !== null) cacheCompilation(queryClient, workspaceId, compilation);
    },
  });
}

/** Delete one and its file. */
export function useDeleteCompilation(): UseMutationResult<
  { id: string },
  Error,
  { readonly runId: string; readonly compilationId: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(deleteCompilationEndpoint, {
        params: { runId: input.runId, compilationId: input.compilationId },
      }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({
        queryKey: compilationsQueryKey(workspaceId, input.runId),
      });
    },
  });
}

/** A run's series, oldest first. */
export function useRepurposeSeries(
  runId: string | null,
): UseQueryResult<{ runId: string; series: RepurposeSeries[] }> {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();
  return useQuery({
    queryKey: seriesQueryKey(workspaceId ?? "none", runId ?? "none"),
    enabled: workspaceId !== null && runId !== null,
    retry: noRetryOn4xx,
    // A shape still being finished takes its labels a little later.
    refetchInterval: (query) =>
      (query.state.data?.series ?? []).some((entry) => entry.parts.some((part) => part.pending > 0))
        ? 15_000
        : false,
    queryFn: () => client.call(seriesEndpoint, { params: { runId: runId ?? "" } }),
  });
}

/**
 * Make a series of clips; its parts follow the video's order. Rejects with 409
 * `repurpose/series_clip_taken` or `repurpose/series_clips_not_ready`.
 */
export function useCreateSeries(): UseMutationResult<
  RepurposeSeries,
  Error,
  { readonly runId: string; readonly clipIds: readonly string[] }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(createSeriesEndpoint, {
        params: { runId: input.runId },
        body: { clipIds: [...input.clipIds] },
      }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: seriesQueryKey(workspaceId, input.runId) });
      // The labels are edits: the clips' captioned videos are made again.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.repurposeClips(workspaceId, input.runId),
      });
    },
  });
}

/** "Remove series labels". */
export function useRemoveSeries(): UseMutationResult<
  { id: string; restored: number },
  Error,
  { readonly runId: string; readonly seriesId: string }
> {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();
  return useMutation({
    mutationFn: (input) =>
      client.call(deleteSeriesEndpoint, {
        params: { runId: input.runId, seriesId: input.seriesId },
      }),
    onSettled: (_data, _error, input) => {
      if (workspaceId === null) return;
      void queryClient.invalidateQueries({ queryKey: seriesQueryKey(workspaceId, input.runId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.repurposeClips(workspaceId, input.runId),
      });
    },
  });
}
