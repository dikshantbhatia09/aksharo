import { beforeEach, describe, expect, it, vi } from "vitest";
import { PodcastsController } from "./podcasts.controller.js";

describe("PodcastsController", () => {
  let mockService: any;
  let controller: PodcastsController;

  beforeEach(() => {
    mockService = {
      connectShow: vi.fn().mockResolvedValue({ id: "show-1", title: "Test Show" }),
      searchPodcasts: vi.fn().mockResolvedValue([{ title: "Found Show" }]),
      listShows: vi.fn().mockResolvedValue([{ id: "show-1" }]),
      getShow: vi.fn().mockResolvedValue({ id: "show-1", title: "Test Show" }),
      updateShow: vi.fn().mockResolvedValue({ id: "show-1", autoRepurpose: false }),
      deleteShow: vi.fn().mockResolvedValue({ deleted: true }),
      syncFeed: vi.fn().mockResolvedValue({ updated: true, newEpisodes: 1 }),
      repurposeEpisode: vi.fn().mockResolvedValue({ projectId: "proj-1", status: "READY" }),
    };

    controller = new PodcastsController(mockService);
  });

  it("calls connectShow with validated input", async () => {
    const result = await controller.connect("ws-1", {
      feedUrl: "https://example.com/rss.xml",
      autoRepurpose: true,
    });
    expect(result).toEqual({ id: "show-1", title: "Test Show" });
    expect(mockService.connectShow).toHaveBeenCalledWith("ws-1", {
      feedUrl: "https://example.com/rss.xml",
      autoRepurpose: true,
    });
  });

  it("calls search with query", async () => {
    const result = await controller.search("Tech", "10");
    expect(result).toEqual([{ title: "Found Show" }]);
    expect(mockService.searchPodcasts).toHaveBeenCalledWith("Tech", 10);
  });

  it("calls repurposeEpisode with workspace and user ID", async () => {
    const result = await controller.repurpose("ws-1", "user-1", "ep-1");
    expect(result).toEqual({ projectId: "proj-1", status: "READY" });
    expect(mockService.repurposeEpisode).toHaveBeenCalledWith("ws-1", "user-1", "ep-1", undefined);
  });
});

