import { describe, expect, it, vi } from "vitest";
import { ItunesSearchService } from "./itunes-search.service.js";

describe("ItunesSearchService", () => {
  const service = new ItunesSearchService();

  it("returns search results mapped with title, author, and feedUrl", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            collectionId: 123456,
            collectionName: "The Daily Tech",
            artistName: "Tech News Network",
            feedUrl: "https://feeds.example.com/dailytech.xml",
            artworkUrl600: "https://images.example.com/art600.jpg",
            trackCount: 150,
            genres: ["Technology", "News"],
          },
        ],
      }),
    });

    const results = await service.search("Daily Tech", 10, mockFetch as any);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: "123456",
      title: "The Daily Tech",
      author: "Tech News Network",
      feedUrl: "https://feeds.example.com/dailytech.xml",
      artworkUrl: "https://images.example.com/art600.jpg",
      episodeCount: 150,
      genres: ["Technology", "News"],
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("search?term=Daily%20Tech&entity=podcast"),
      expect.anything(),
    );
  });

  it("handles Apple Podcasts direct URL by calling lookup", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            collectionId: 987654321,
            collectionName: "Huberman Lab",
            artistName: "Andrew Huberman",
            feedUrl: "https://feeds.megaphone.fm/hubermanlab",
            artworkUrl600: "https://images.example.com/huberman.jpg",
          },
        ],
      }),
    });

    const results = await service.search(
      "https://podcasts.apple.com/us/podcast/huberman-lab/id987654321",
      10,
      mockFetch as any,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Huberman Lab");
    expect(results[0]?.feedUrl).toBe("https://feeds.megaphone.fm/hubermanlab");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("lookup?id=987654321&entity=podcast"),
      expect.anything(),
    );
  });

  it("returns empty array when search fails or returns non-ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const results = await service.search("broken query", 10, mockFetch as any);
    expect(results).toEqual([]);
  });
});

