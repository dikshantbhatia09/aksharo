import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  REDIS_BROLL_CACHE_TTL_SEC,
  StockProviderService,
  type StockVideoCandidate,
} from "./stock-provider.service.js";
import { AppException } from "../common/index.js";

describe("StockProviderService", () => {
  let prismaMock: any;
  let redisMock: any;
  let service: StockProviderService;

  beforeEach(() => {
    prismaMock = {
      project: {
        findUnique: vi.fn(),
      },
      projectBrollCue: {
        create: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };

    redisMock = {
      client: {
        get: vi.fn(),
        set: vi.fn(),
      },
    };

    service = new StockProviderService(prismaMock, redisMock);
  });

  describe("searchVideos", () => {
    it("returns cached stock videos when available in Redis", async () => {
      const cachedCandidates: StockVideoCandidate[] = [
        {
          id: "cached-1",
          provider: "PEXELS",
          durationSec: 12,
          width: 1080,
          height: 1920,
          videoUrl: "https://videos.pexels.com/cached.mp4",
          previewImageUrl: "https://images.pexels.com/preview.jpg",
          authorName: "Test Creator",
          resolution: "1080p",
        },
      ];

      redisMock.client.get.mockResolvedValueOnce(JSON.stringify(cachedCandidates));

      const results = await service.searchVideos({
        query: "rocket launch",
        orientation: "portrait",
      });

      expect(results).toEqual(cachedCandidates);
      expect(redisMock.client.get).toHaveBeenCalledWith(
        "broll:videos:pexels:rocket launch:portrait:1",
      );
      // Verify no network fetch was needed
      expect(redisMock.client.set).not.toHaveBeenCalled();
    });

    it("falls back to curated Storyblocks catalogue when Pexels is not configured or misses", async () => {
      redisMock.client.get.mockResolvedValueOnce(null);

      const results = await service.searchVideos({
        query: "luxury real estate",
        orientation: "portrait",
      });

      expect(results.length).toBeGreaterThan(0);
      const first = results[0];
      expect(first).toBeDefined();
      expect(first?.provider).toBe("STORYBLOCKS");
      expect(first?.width).toBe(1080);
      expect(first?.height).toBe(1920);
      expect(first?.resolution).toBe("1080p");
      expect(first?.videoUrl).toContain(".mp4");

      // Verify cached into Redis with 24-hour TTL
      expect(redisMock.client.set).toHaveBeenCalledWith(
        "broll:videos:pexels:luxury real estate:portrait:1",
        expect.any(String),
        "EX",
        REDIS_BROLL_CACHE_TTL_SEC,
      );
    });

    it("returns empty array for empty query string", async () => {
      const results = await service.searchVideos({ query: "   " });
      expect(results).toEqual([]);
    });
  });

  describe("ProjectBrollCue Persistence Operations", () => {
    it("creates a B-roll cue for a valid project", async () => {
      prismaMock.project.findUnique.mockResolvedValueOnce({ id: "proj-1" });
      prismaMock.projectBrollCue.create.mockResolvedValueOnce({
        id: "cue-1",
        projectId: "proj-1",
        startSec: 4.5,
        endSec: 8.0,
        query: "rocket launch",
        stockVideoUri: "https://assets.aksharo.com/stock/rocket.mp4",
        sourceProvider: "PEXELS",
        status: "ACTIVE",
      });

      const cue = await service.createCue({
        projectId: "proj-1",
        startSec: 4.5,
        endSec: 8.0,
        query: "rocket launch",
        stockVideoUri: "https://assets.aksharo.com/stock/rocket.mp4",
      });

      expect(cue.id).toBe("cue-1");
      expect(cue.startSec).toBe(4.5);
      expect(prismaMock.projectBrollCue.create).toHaveBeenCalledWith({
        data: {
          projectId: "proj-1",
          startSec: 4.5,
          endSec: 8.0,
          query: "rocket launch",
          stockVideoUri: "https://assets.aksharo.com/stock/rocket.mp4",
          sourceProvider: "PEXELS",
          status: "ACTIVE",
        },
      });
    });

    it("throws NOT_FOUND when project does not exist", async () => {
      prismaMock.project.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.createCue({
          projectId: "non-existent",
          startSec: 2.0,
          endSec: 5.0,
          query: "ad dashboard",
          stockVideoUri: "https://assets.aksharo.com/stock/ad.mp4",
        }),
      ).rejects.toThrow(AppException);
    });

    it("throws BAD_REQUEST when endSec <= startSec", async () => {
      prismaMock.project.findUnique.mockResolvedValueOnce({ id: "proj-1" });

      await expect(
        service.createCue({
          projectId: "proj-1",
          startSec: 5.0,
          endSec: 3.0,
          query: "ad dashboard",
          stockVideoUri: "https://assets.aksharo.com/stock/ad.mp4",
        }),
      ).rejects.toThrow(AppException);
    });

    it("gets all active cues for a project in startSec order", async () => {
      prismaMock.projectBrollCue.findMany.mockResolvedValueOnce([
        { id: "cue-1", startSec: 2.5, endSec: 5.0 },
        { id: "cue-2", startSec: 8.0, endSec: 11.5 },
      ]);

      const cues = await service.getCues("proj-1");
      expect(cues).toHaveLength(2);
      expect(prismaMock.projectBrollCue.findMany).toHaveBeenCalledWith({
        where: { projectId: "proj-1", status: { not: "DELETED" } },
        orderBy: { startSec: "asc" },
      });
    });

    it("swaps the stock video for an existing cue", async () => {
      prismaMock.projectBrollCue.findUnique.mockResolvedValueOnce({
        id: "cue-1",
        stockVideoUri: "https://old.mp4",
      });
      prismaMock.projectBrollCue.update.mockResolvedValueOnce({
        id: "cue-1",
        stockVideoUri: "https://new.mp4",
        sourceProvider: "STORYBLOCKS",
      });

      const updated = await service.swapCueVideo("cue-1", "https://new.mp4", "STORYBLOCKS");
      expect(updated.stockVideoUri).toBe("https://new.mp4");
      expect(prismaMock.projectBrollCue.update).toHaveBeenCalledWith({
        where: { id: "cue-1" },
        data: {
          stockVideoUri: "https://new.mp4",
          sourceProvider: "STORYBLOCKS",
        },
      });
    });

    it("deletes a cue", async () => {
      prismaMock.projectBrollCue.findUnique.mockResolvedValueOnce({ id: "cue-1" });
      prismaMock.projectBrollCue.delete.mockResolvedValueOnce({ id: "cue-1" });

      const deleted = await service.deleteCue("cue-1");
      expect(deleted).toBe(true);
      expect(prismaMock.projectBrollCue.delete).toHaveBeenCalledWith({
        where: { id: "cue-1" },
      });
    });
  });
});
