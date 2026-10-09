"use client";

import {
  Check,
  Clock,
  ExternalLink,
  Flame,
  ListMusic,
  Loader2,
  Mic,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";
import NextLink from "next/link";
import * as React from "react";

import { Button, EmptyState, Input, PageHeader, Skeleton, cn } from "@montaj/ui";

import {
  useConnectPodcast,
  useDeletePodcast,
  usePodcastShow,
  usePodcastShows,
  useRepurposeEpisode,
  useSearchPodcasts,
  useSyncPodcast,
  useUpdatePodcast,
  type PodcastEpisode,
  type PodcastSearchResult,
  type PodcastShow,
} from "./use-podcasts";

export function PodcastsView(): React.JSX.Element {
  const [selectedShowId, setSelectedShowId] = React.useState<string | null>(null);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [customRssUrl, setCustomRssUrl] = React.useState("");
  const [isConnectingCustom, setIsConnectingCustom] = React.useState(false);
  const [showAddForm, setShowAddForm] = React.useState(false);

  const { data: shows, isLoading: loadingShows } = usePodcastShows();
  const { data: activeShow, isLoading: loadingActiveShow } = usePodcastShow(
    selectedShowId || (shows && shows.length > 0 ? shows[0]?.id ?? null : null),
  );

  const { data: searchResults, isFetching: isSearching } = useSearchPodcasts(searchQuery);
  const connectMutation = useConnectPodcast();
  const syncMutation = useSyncPodcast();
  const updateMutation = useUpdatePodcast();
  const deleteMutation = useDeletePodcast();
  const repurposeMutation = useRepurposeEpisode();

  // Keep selectedShowId synced if shows load
  React.useEffect(() => {
    if (!selectedShowId && shows && shows.length > 0 && shows[0]) {
      setSelectedShowId(shows[0].id);
    }
  }, [shows, selectedShowId]);

  const handleConnectShow = async (feedUrl: string) => {
    try {
      const show = await connectMutation.mutateAsync({ feedUrl, autoRepurpose: true });
      setSelectedShowId(show.id);
      setShowAddForm(false);
      setSearchQuery("");
      setCustomRssUrl("");
    } catch (err) {
      console.error("Failed to connect podcast:", err);
    }
  };

  const handleToggleAutoRepurpose = async (show: PodcastShow) => {
    await updateMutation.mutateAsync({
      showId: show.id,
      autoRepurpose: !show.autoRepurpose,
    });
  };

  const handleSyncFeed = async (showId: string) => {
    await syncMutation.mutateAsync(showId);
  };

  const handleDeleteShow = async (showId: string) => {
    if (confirm("Disconnect this podcast show from your workspace?")) {
      await deleteMutation.mutateAsync(showId);
      if (selectedShowId === showId) {
        setSelectedShowId(null);
      }
    }
  };

  const handleRepurpose = async (episodeId: string) => {
    await repurposeMutation.mutateAsync({ episodeId });
  };

  const formatDuration = (sec?: number | null) => {
    if (!sec) return "Audio Episode";
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    if (hrs > 0) return `${hrs}h ${mins}m`;
    return `${mins}m`;
  };

  return (
    <div className="flex flex-col gap-8 pb-16" data-testid="podcasts-view">
      <PageHeader
        eyebrow="Ingestion Engine — Feature 06"
        title="Podcast RSS Ingestion & Automated Episode Watcher"
        description="Link your show once. Aksharo automatically watches your RSS feed, parses show notes and chapters, and turns new episodes into viral vertical clips."
        actions={
          <Button
            variant={showAddForm ? "outline" : "primary"}
            size="sm"
            onClick={() => setShowAddForm(!showAddForm)}
          >
            {showAddForm ? "Cancel" : <><Plus className="mr-1.5 h-4 w-4" /> Connect Podcast</>}
          </Button>
        }
      />

      {/* Connect Modal / Section */}
      {showAddForm && (
        <div className="rounded-xl border border-border bg-bg-1 p-6 shadow-sm flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-fg-0">Connect a Podcast Show</h3>
            <p className="text-sm text-fg-2">
              Search by podcast title in the Apple Podcasts directory, or paste a raw RSS feed URL directly.
            </p>
          </div>

          <div className="flex flex-col gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-fg-2" />
              <Input
                placeholder="Search podcast name (e.g. The Daily, Huberman Lab, SaaS Velocity)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
              />
              {isSearching && (
                <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-fg-2" />
              )}
            </div>

            {/* Live Search Results */}
            {searchResults && searchResults.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-72 overflow-y-auto p-1">
                {searchResults.map((item: PodcastSearchResult) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-border bg-bg-2 hover:border-accent transition-colors"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      {item.artworkUrl ? (
                        <img
                          src={item.artworkUrl}
                          alt={item.title}
                          className="w-12 h-12 rounded-md object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-12 h-12 rounded-md bg-bg-3 flex items-center justify-center flex-shrink-0">
                          <Mic className="w-6 h-6 text-fg-2" />
                        </div>
                      )}
                      <div className="truncate">
                        <p className="font-medium text-sm text-fg-0 truncate">{item.title}</p>
                        <p className="text-xs text-fg-2 truncate">{item.author || "Podcast Host"}</p>
                        {item.episodeCount && (
                          <span className="text-[10px] text-fg-3">{item.episodeCount} episodes</span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={connectMutation.isPending}
                      onClick={() => handleConnectShow(item.feedUrl)}
                    >
                      Connect
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-3 my-2">
              <div className="h-px bg-border flex-1" />
              <span className="text-xs text-fg-3 uppercase tracking-wider font-semibold">Or Direct RSS Feed</span>
              <div className="h-px bg-border flex-1" />
            </div>

            <div className="flex gap-2">
              <Input
                placeholder="https://feeds.buzzsprout.com/123456.rss or https://anchor.fm/s/..."
                value={customRssUrl}
                onChange={(e) => setCustomRssUrl(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={!customRssUrl || connectMutation.isPending}
                onClick={() => handleConnectShow(customRssUrl)}
              >
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Import Feed"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Shows Tabs & Content */}
      {loadingShows ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : !shows || shows.length === 0 ? (
        <EmptyState
          icon={<Radio className="h-10 w-10 text-fg-2" />}
          title="No podcast shows connected"
          description="Connect your show's RSS feed to enable autonomous episode detection and 1-click clipping."
          action={
            <Button variant="primary" onClick={() => setShowAddForm(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Connect Your First Podcast
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {/* Shows selection tabs */}
          {shows.length > 1 && (
            <div className="flex gap-2 overflow-x-auto pb-2 border-b border-border">
              {shows.map((show) => (
                <button
                  key={show.id}
                  onClick={() => setSelectedShowId(show.id)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap",
                    activeShow?.id === show.id
                      ? "bg-accent/10 text-accent border border-accent/20"
                      : "text-fg-1 hover:bg-bg-2 hover:text-fg-0",
                  )}
                >
                  <Radio className="w-4 h-4" />
                  {show.title}
                </button>
              ))}
            </div>
          )}

          {/* Active Show Banner */}
          {activeShow && (
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 p-5 rounded-xl border border-border bg-bg-1 shadow-sm">
              <div className="flex items-center gap-4">
                {activeShow.imageUrl ? (
                  <img
                    src={activeShow.imageUrl}
                    alt={activeShow.title}
                    className="w-16 h-16 rounded-lg object-cover border border-border shadow-sm"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-lg bg-bg-3 flex items-center justify-center border border-border">
                    <Mic className="w-8 h-8 text-fg-2" />
                  </div>
                )}
                <div>
                  <h2 className="text-xl font-bold text-fg-0">{activeShow.title}</h2>
                  <p className="text-sm text-fg-2">{activeShow.author || "Podcast Show"}</p>
                  <p className="text-xs text-fg-3 mt-1 flex items-center gap-1.5">
                    <Radio className="w-3 h-3 text-emerald-500" />
                    Feed connected: {activeShow.feedUrl.slice(0, 45)}...
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                {/* Auto Repurpose Toggle */}
                <button
                  onClick={() => handleToggleAutoRepurpose(activeShow)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors",
                    activeShow.autoRepurpose
                      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                      : "bg-bg-2 text-fg-2 border-border",
                  )}
                  title="Toggle autonomous clipping on new episode publish"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Auto-Repurpose: {activeShow.autoRepurpose ? "Active" : "Paused"}
                </button>

                {/* Manual Sync Button */}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={syncMutation.isPending}
                  onClick={() => handleSyncFeed(activeShow.id)}
                >
                  <RefreshCw
                    className={cn(
                      "w-3.5 h-3.5 mr-1.5",
                      syncMutation.isPending && "animate-spin",
                    )}
                  />
                  Sync Feed
                </Button>

                {/* Disconnect Button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                  onClick={() => handleDeleteShow(activeShow.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* Episode Catalog */}
          <div className="flex flex-col gap-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold text-fg-0">
                Episode Catalog ({activeShow?.episodes?.length || 0})
              </h3>
            </div>

            {loadingActiveShow ? (
              <div className="space-y-3">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            ) : !activeShow?.episodes || activeShow.episodes.length === 0 ? (
              <p className="text-sm text-fg-2 py-8 text-center border border-dashed rounded-lg">
                No episodes found in this feed.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {activeShow.episodes.map((ep: PodcastEpisode) => (
                  <div
                    key={ep.id}
                    className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 rounded-xl border border-border bg-bg-1 hover:border-fg-3/30 transition-all shadow-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs text-fg-3 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {new Date(ep.publishedAt).toLocaleDateString()}
                        </span>
                        <span className="text-xs text-fg-3">·</span>
                        <span className="text-xs text-fg-3 font-medium">
                          {formatDuration(ep.durationSec)}
                        </span>
                        {ep.chapters && ep.chapters.length > 0 && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent/10 text-accent">
                            <ListMusic className="w-3 h-3" />
                            {ep.chapters.length} Chapters Seeded
                          </span>
                        )}
                        {ep.isProcessed && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-500">
                            <Check className="w-3 h-3" /> Ready
                          </span>
                        )}
                      </div>

                      <h4 className="text-base font-medium text-fg-0 truncate">
                        {ep.title}
                      </h4>

                      {ep.summary && (
                        <p className="text-xs text-fg-2 line-clamp-1 mt-1">
                          {ep.summary}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-center">
                      {ep.projectId ? (
                        <Button variant="outline" size="sm" asChild>
                          <NextLink href={`/p/${ep.projectId}`}>
                            Open Project <ExternalLink className="w-3 h-3 ml-1.5" />
                          </NextLink>
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={repurposeMutation.isPending}
                          onClick={() => handleRepurpose(ep.id)}
                        >
                          <Flame className="w-3.5 h-3.5 mr-1.5 text-amber-400" />
                          1-Click Repurpose
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

