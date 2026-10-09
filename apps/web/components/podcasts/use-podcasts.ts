"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { defineEndpoint, isApiError, useApiClient, useWorkspaceId } from "@montaj/api-client";

export interface PodcastChapter {
  readonly title: string;
  readonly startSec: number;
  readonly endSec?: number;
}

export interface PodcastEpisode {
  readonly id: string;
  readonly showId: string;
  readonly guid: string;
  readonly title: string;
  readonly audioUrl: string;
  readonly durationSec?: number | null;
  readonly publishedAt: string;
  readonly isProcessed: boolean;
  readonly projectId?: string | null;
  readonly description?: string | null;
  readonly summary?: string | null;
  readonly chapters?: readonly PodcastChapter[];
  readonly createdAt: string;
}

export interface PodcastShow {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly feedUrl: string;
  readonly author?: string | null;
  readonly imageUrl?: string | null;
  readonly lastBuildDate?: string | null;
  readonly autoRepurpose: boolean;
  readonly episodeCount?: number;
  readonly episodes?: readonly PodcastEpisode[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PodcastSearchResult {
  readonly id: string;
  readonly title: string;
  readonly author?: string;
  readonly feedUrl: string;
  readonly artworkUrl?: string;
  readonly episodeCount?: number;
  readonly genres?: readonly string[];
}

export interface ConnectPodcastRequest {
  readonly feedUrl: string;
  readonly autoRepurpose?: boolean;
}

export interface UpdatePodcastRequest {
  readonly showId: string;
  readonly autoRepurpose?: boolean;
}

export interface SyncPodcastResponse {
  readonly updated: boolean;
  readonly newEpisodes: number;
  readonly episodes: readonly PodcastEpisode[];
}

export interface RepurposeEpisodeRequest {
  readonly episodeId: string;
  readonly styleId?: string;
  readonly sourceLanguage?: string;
  readonly topic?: string;
}

export interface RepurposeEpisodeResponse {
  readonly projectId: string;
  readonly episodeId: string;
  readonly status: string;
}

export interface RepurposeEpisodeBody {
  readonly styleId?: string;
  readonly sourceLanguage?: string;
  readonly topic?: string;
}

const listShowsEndpoint = defineEndpoint<void, PodcastShow[]>({
  method: "GET",
  path: "/podcasts",
  auth: "bearer",
});

const getShowEndpoint = defineEndpoint<void, PodcastShow>({
  method: "GET",
  path: "/podcasts/{showId}",
  auth: "bearer",
});

const searchShowsEndpoint = defineEndpoint<void, PodcastSearchResult[]>({
  method: "GET",
  path: "/podcasts/search",
  auth: "bearer",
});

const connectShowEndpoint = defineEndpoint<ConnectPodcastRequest, PodcastShow>({
  method: "POST",
  path: "/podcasts/connect",
  auth: "bearer",
});

const updateShowEndpoint = defineEndpoint<{ autoRepurpose?: boolean }, PodcastShow>({
  method: "PATCH",
  path: "/podcasts/{showId}",
  auth: "bearer",
});

const deleteShowEndpoint = defineEndpoint<void, { deleted: boolean }>({
  method: "DELETE",
  path: "/podcasts/{showId}",
  auth: "bearer",
});

const syncShowEndpoint = defineEndpoint<void, SyncPodcastResponse>({
  method: "POST",
  path: "/podcasts/{showId}/sync",
  auth: "bearer",
});

const repurposeEpisodeEndpoint = defineEndpoint<RepurposeEpisodeBody, RepurposeEpisodeResponse>({
  method: "POST",
  path: "/podcasts/episodes/{episodeId}/repurpose",
  auth: "bearer",
});

function podcastKeys(workspaceId: string) {
  return ["workspace", workspaceId, "podcasts"] as const;
}

export function usePodcastShows() {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();

  return useQuery({
    queryKey: podcastKeys(workspaceId ?? "none"),
    enabled: Boolean(workspaceId),
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
    queryFn: () => client.call(listShowsEndpoint),
  });
}

export function usePodcastShow(showId: string | null) {
  const client = useApiClient();
  const workspaceId = useWorkspaceId();

  return useQuery({
    queryKey: [...podcastKeys(workspaceId ?? "none"), "show", showId],
    enabled: Boolean(workspaceId && showId),
    queryFn: () => client.call(getShowEndpoint, { params: { showId: showId! } }),
  });
}

export function useSearchPodcasts(query: string) {
  const client = useApiClient();
  const trimmed = query.trim();

  return useQuery({
    queryKey: ["podcasts", "search", trimmed],
    enabled: trimmed.length >= 2,
    queryFn: async () => client.call(searchShowsEndpoint, { query: { q: trimmed } }),
  });
}

export function useConnectPodcast() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  return useMutation({
    mutationFn: (req: ConnectPodcastRequest) => client.call(connectShowEndpoint, { body: req }),
    onSuccess: () => {
      if (workspaceId) {
        queryClient.invalidateQueries({ queryKey: podcastKeys(workspaceId) });
      }
    },
  });
}

export function useUpdatePodcast() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  return useMutation({
    mutationFn: (req: UpdatePodcastRequest) =>
      client.call(updateShowEndpoint, {
        params: { showId: req.showId },
        body: { autoRepurpose: req.autoRepurpose },
      }),
    onSuccess: (_, variables) => {
      if (workspaceId) {
        queryClient.invalidateQueries({ queryKey: podcastKeys(workspaceId) });
        queryClient.invalidateQueries({
          queryKey: [...podcastKeys(workspaceId), "show", variables.showId],
        });
      }
    },
  });
}

export function useDeletePodcast() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  return useMutation({
    mutationFn: (showId: string) => client.call(deleteShowEndpoint, { params: { showId } }),
    onSuccess: () => {
      if (workspaceId) {
        queryClient.invalidateQueries({ queryKey: podcastKeys(workspaceId) });
      }
    },
  });
}

export function useSyncPodcast() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  return useMutation({
    mutationFn: (showId: string) => client.call(syncShowEndpoint, { params: { showId } }),
    onSuccess: (_, showId) => {
      if (workspaceId) {
        queryClient.invalidateQueries({ queryKey: podcastKeys(workspaceId) });
        queryClient.invalidateQueries({
          queryKey: [...podcastKeys(workspaceId), "show", showId],
        });
      }
    },
  });
}

export function useRepurposeEpisode() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const workspaceId = useWorkspaceId();

  return useMutation({
    mutationFn: (req: RepurposeEpisodeRequest) =>
      client.call(repurposeEpisodeEndpoint, {
        params: { episodeId: req.episodeId },
        body: {
          styleId: req.styleId,
          sourceLanguage: req.sourceLanguage,
          topic: req.topic,
        },
      }),
    onSuccess: () => {
      if (workspaceId) {
        queryClient.invalidateQueries({ queryKey: podcastKeys(workspaceId) });
        queryClient.invalidateQueries({ queryKey: ["projects"] });
      }
    },
  });
}
