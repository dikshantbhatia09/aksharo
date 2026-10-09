import { describe, expect, it, vi, beforeEach } from "vitest";
import { PodcastsService } from "./podcasts.service.js";
import { RssParserService } from "./rss-parser.service.js";
import { ItunesSearchService } from "./itunes-search.service.js";

describe("PodcastsService", () => {
  let service: PodcastsService;
  let mockPrisma: any;
  let rssParser: RssParserService;
  let itunesSearch: ItunesSearchService;

  const mockWorkspaceId = "01HY0000000000000000000001";
  const mockShowId = "show-uuid-123";

  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>SaaS Masterclass</title>
    <itunes:author>Alex Rivera</itunes:author>
    <itunes:image href="https://assets.example.com/art.jpg" />
    <item>
      <title>Ep 1: Going Viral on TikTok</title>
      <guid>ep-1-guid</guid>
      <pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate>
      <enclosure url="https://media.example.com/ep1.mp3" type="audio/mpeg" length="12345" />
      <itunes:duration>1800</itunes:duration>
      <description>Show Notes:
00:00 - Introduction
05:15 - Retention Strategies
15:00 - Q&A</description>
    </item>
  </channel>
</rss>`;

  beforeEach(() => {
    mockPrisma = {
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ id: mockWorkspaceId, name: "Test Workspace" }),
      },
      podcastShow: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        findMany: vi.fn(),
        upsert: vi.fn().mockResolvedValue({
          id: mockShowId,
          workspaceId: mockWorkspaceId,
          title: "SaaS Masterclass",
          feedUrl: "https://feeds.example.com/saas.xml",
          author: "Alex Rivera",
          imageUrl: "https://assets.example.com/art.jpg",
          autoRepurpose: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: vi.fn(),
        delete: vi.fn(),
      },
      podcastEpisode: {
        upsert: vi.fn().mockResolvedValue({
          id: "ep-uuid-1",
          showId: mockShowId,
          guid: "ep-1-guid",
          title: "Ep 1: Going Viral on TikTok",
          audioUrl: "https://media.example.com/ep1.mp3",
          durationSec: 1800,
          publishedAt: new Date(),
          isProcessed: false,
          projectId: null,
          chapters: [],
          createdAt: new Date(),
        }),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      project: {
        create: vi.fn().mockResolvedValue({
          id: "01PROJ00000000000000000001",
          workspaceId: mockWorkspaceId,
          title: "Ep 1: Going Viral on TikTok",
        }),
      },
      transcriptChapter: {
        create: vi.fn().mockResolvedValue({ id: "ch-1" }),
      },
    };

    rssParser = new RssParserService();
    itunesSearch = new ItunesSearchService();
    service = new PodcastsService(mockPrisma as any, rssParser, itunesSearch);
  });

  it("connects show and indexes episodes", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ etag: '"test-etag-123"' }),
      text: async () => sampleXml,
    });

    mockPrisma.podcastShow.findFirst.mockResolvedValue({
      id: mockShowId,
      workspaceId: mockWorkspaceId,
      title: "SaaS Masterclass",
      feedUrl: "https://feeds.example.com/saas.xml",
      author: "Alex Rivera",
      imageUrl: "https://assets.example.com/art.jpg",
      autoRepurpose: true,
      lastBuildDate: null,
      episodes: [
        {
          id: "ep-uuid-1",
          showId: mockShowId,
          guid: "ep-1-guid",
          title: "Ep 1: Going Viral on TikTok",
          audioUrl: "https://media.example.com/ep1.mp3",
          durationSec: 1800,
          publishedAt: new Date(),
          isProcessed: false,
          projectId: null,
          description: "Show notes",
          summary: null,
          chapters: [],
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await service.connectShow(
      mockWorkspaceId,
      { feedUrl: "https://feeds.example.com/saas.xml", autoRepurpose: true },
      mockFetch as any,
    );

    expect(result.id).toBe(mockShowId);
    expect(result.title).toBe("SaaS Masterclass");
    expect(result.episodes).toHaveLength(1);
    expect(mockPrisma.podcastShow.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { feedUrl: "https://feeds.example.com/saas.xml" },
      }),
    );
    expect(mockPrisma.podcastEpisode.upsert).toHaveBeenCalled();
  });

  it("handles HTTP 304 during syncFeed without re-inserting episodes", async () => {
    mockPrisma.podcastShow.findUnique.mockResolvedValue({
      id: mockShowId,
      workspaceId: mockWorkspaceId,
      title: "SaaS Masterclass",
      feedUrl: "https://feeds.example.com/saas.xml",
      etag: '"test-etag-123"',
      lastBuildDate: new Date("2026-10-05T10:00:00Z"),
      episodes: [{ guid: "ep-1-guid" }],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      status: 304,
      ok: false,
    });

    const syncResult = await service.syncFeed(mockShowId, mockFetch as any);
    expect(syncResult.updated).toBe(false);
    expect(syncResult.newEpisodes).toBe(0);
    expect(mockPrisma.podcastEpisode.create).not.toHaveBeenCalled();
  });

  it("repurposes episode, creates project, and seeds chapters", async () => {
    mockPrisma.podcastEpisode.findUnique.mockResolvedValue({
      id: "ep-uuid-1",
      showId: mockShowId,
      guid: "ep-1-guid",
      title: "Ep 1: Going Viral on TikTok",
      audioUrl: "https://media.example.com/ep1.mp3",
      durationSec: 1800,
      isProcessed: false,
      projectId: null,
      chapters: [
        { title: "Introduction", startSec: 0, endSec: 315 },
        { title: "Retention Strategies", startSec: 315, endSec: 900 },
      ],
      show: {
        id: mockShowId,
        workspaceId: mockWorkspaceId,
      },
    });

    const repurposeResult = await service.repurposeEpisode(
      mockWorkspaceId,
      "user-1",
      "ep-uuid-1",
    );

    expect(repurposeResult.status).toBe("READY");
    expect(repurposeResult.projectId).toBeDefined();
    expect(mockPrisma.project.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: mockWorkspaceId,
          title: "Ep 1: Going Viral on TikTok",
          durationMs: 1800000,
        }),
      }),
    );

    // Verify User Story 3: Chapters seeded into transcriptChapter
    expect(mockPrisma.transcriptChapter.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.podcastEpisode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "ep-uuid-1" },
        data: expect.objectContaining({
          isProcessed: true,
        }),
      }),
    );
  });
});

