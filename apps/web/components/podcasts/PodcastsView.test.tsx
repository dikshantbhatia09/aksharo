import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";

import { PodcastsView } from "./PodcastsView";
import * as usePodcastsModule from "./use-podcasts";

vi.mock("./use-podcasts", () => ({
  usePodcastShows: vi.fn(),
  usePodcastShow: vi.fn(),
  useSearchPodcasts: vi.fn(),
  useConnectPodcast: vi.fn(),
  useSyncPodcast: vi.fn(),
  useUpdatePodcast: vi.fn(),
  useDeletePodcast: vi.fn(),
  useRepurposeEpisode: vi.fn(),
}));

describe("PodcastsView", () => {
  const mockMutateConnect = vi.fn();
  const mockMutateSync = vi.fn();
  const mockMutateUpdate = vi.fn();
  const mockMutateDelete = vi.fn();
  const mockMutateRepurpose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(usePodcastsModule.useConnectPodcast).mockReturnValue({
      mutateAsync: mockMutateConnect,
      isPending: false,
    } as any);

    vi.mocked(usePodcastsModule.useSyncPodcast).mockReturnValue({
      mutateAsync: mockMutateSync,
      isPending: false,
    } as any);

    vi.mocked(usePodcastsModule.useUpdatePodcast).mockReturnValue({
      mutateAsync: mockMutateUpdate,
      isPending: false,
    } as any);

    vi.mocked(usePodcastsModule.useDeletePodcast).mockReturnValue({
      mutateAsync: mockMutateDelete,
      isPending: false,
    } as any);

    vi.mocked(usePodcastsModule.useRepurposeEpisode).mockReturnValue({
      mutateAsync: mockMutateRepurpose,
      isPending: false,
    } as any);

    vi.mocked(usePodcastsModule.useSearchPodcasts).mockReturnValue({
      data: [],
      isFetching: false,
    } as any);
  });

  it("renders empty state when no podcast shows are connected", () => {
    vi.mocked(usePodcastsModule.usePodcastShows).mockReturnValue({
      data: [],
      isLoading: false,
    } as any);

    vi.mocked(usePodcastsModule.usePodcastShow).mockReturnValue({
      data: null,
      isLoading: false,
    } as any);

    render(<PodcastsView />);

    expect(screen.getByText("No podcast shows connected")).toBeInTheDocument();
    expect(screen.getByText("Connect Your First Podcast")).toBeInTheDocument();
  });

  it("renders connected show with its episode catalog and chapters", () => {
    const mockShow: usePodcastsModule.PodcastShow = {
      id: "show-1",
      workspaceId: "ws-1",
      title: "The Tech Founder Podcast",
      feedUrl: "https://feeds.buzzsprout.com/1234.rss",
      author: "Jane Doe",
      imageUrl: "https://assets.example.com/art.jpg",
      autoRepurpose: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      episodes: [
        {
          id: "ep-1",
          showId: "show-1",
          guid: "ep-1-guid",
          title: "Ep 42: Scaling to $10M ARR",
          audioUrl: "https://media.example.com/ep42.mp3",
          durationSec: 2712,
          publishedAt: "2026-10-05T09:00:00Z",
          isProcessed: false,
          summary: "Deep dive into SaaS scaling playbooks.",
          chapters: [
            { title: "Intro", startSec: 0, endSec: 270 },
            { title: "First $1M", startSec: 270, endSec: 1100 },
          ],
          createdAt: new Date().toISOString(),
        },
      ],
    };

    vi.mocked(usePodcastsModule.usePodcastShows).mockReturnValue({
      data: [mockShow],
      isLoading: false,
    } as any);

    vi.mocked(usePodcastsModule.usePodcastShow).mockReturnValue({
      data: mockShow,
      isLoading: false,
    } as any);

    render(<PodcastsView />);

    expect(screen.getByText("The Tech Founder Podcast")).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("Ep 42: Scaling to $10M ARR")).toBeInTheDocument();
    expect(screen.getByText("45m")).toBeInTheDocument();
    expect(screen.getByText("2 Chapters Seeded")).toBeInTheDocument();
    expect(screen.getByText("1-Click Repurpose")).toBeInTheDocument();
  });

  it("triggers repurpose when 1-Click Repurpose button is clicked", () => {
    const mockShow: usePodcastsModule.PodcastShow = {
      id: "show-1",
      workspaceId: "ws-1",
      title: "The Tech Founder Podcast",
      feedUrl: "https://feeds.buzzsprout.com/1234.rss",
      autoRepurpose: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      episodes: [
        {
          id: "ep-1",
          showId: "show-1",
          guid: "ep-1-guid",
          title: "Ep 42: Scaling to $10M ARR",
          audioUrl: "https://media.example.com/ep42.mp3",
          publishedAt: "2026-10-05T09:00:00Z",
          isProcessed: false,
          createdAt: new Date().toISOString(),
        },
      ],
    };

    vi.mocked(usePodcastsModule.usePodcastShows).mockReturnValue({
      data: [mockShow],
      isLoading: false,
    } as any);

    vi.mocked(usePodcastsModule.usePodcastShow).mockReturnValue({
      data: mockShow,
      isLoading: false,
    } as any);

    render(<PodcastsView />);

    const repurposeBtn = screen.getByText("1-Click Repurpose");
    fireEvent.click(repurposeBtn);

    expect(mockMutateRepurpose).toHaveBeenCalledWith({ episodeId: "ep-1" });
  });

  it("toggles auto-repurpose setting", () => {
    const mockShow: usePodcastsModule.PodcastShow = {
      id: "show-1",
      workspaceId: "ws-1",
      title: "The Tech Founder Podcast",
      feedUrl: "https://feeds.buzzsprout.com/1234.rss",
      autoRepurpose: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      episodes: [],
    };

    vi.mocked(usePodcastsModule.usePodcastShows).mockReturnValue({
      data: [mockShow],
      isLoading: false,
    } as any);

    vi.mocked(usePodcastsModule.usePodcastShow).mockReturnValue({
      data: mockShow,
      isLoading: false,
    } as any);

    render(<PodcastsView />);

    const toggleBtn = screen.getByTitle("Toggle autonomous clipping on new episode publish");
    fireEvent.click(toggleBtn);

    expect(mockMutateUpdate).toHaveBeenCalledWith({
      showId: "show-1",
      autoRepurpose: false,
    });
  });
});

