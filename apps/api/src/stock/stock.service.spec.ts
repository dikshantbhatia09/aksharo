import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  StockService,
  REDIS_STOCK_CACHE_TTL_SEC,
} from "./stock.service.js";
import type { PrismaService } from "../common/index.js";
import type { RedisService } from "../common/redis/redis.service.js";
import type { ObjectStore } from "../common/storage/object-store.js";

describe("StockService", () => {
  let service: StockService;
  let mockPrisma: Partial<PrismaService>;
  let mockRedis: {
    client: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
    };
  };
  let mockRawStore: {
    head: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    presignGet: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockPrisma = {
      projectBrollCue: {
        create: vi.fn().mockResolvedValue({ id: "cue-1" }),
      } as unknown as PrismaService["projectBrollCue"],
    };

    mockRedis = {
      client: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue("OK"),
      },
    };

    mockRawStore = {
      head: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      presignGet: vi.fn().mockResolvedValue("https://s3.aksharo.com/presigned-stock.mp4"),
    };

    service = new StockService(
      mockPrisma as PrismaService,
      mockRedis as unknown as RedisService,
      mockRawStore as unknown as ObjectStore,
    );
  });

  describe("getCategories()", () => {
    it("returns standard curated discovery categories", () => {
      const cats = service.getCategories();
      expect(cats).toContain("Technology");
      expect(cats).toContain("Business");
      expect(cats).toContain("Nature");
      expect(cats).toContain("Finance");
      expect(cats).toContain("City");
    });
  });

  describe("search() aggregator & fan-out", () => {
    it("returns curated stock items matching query keywords", async () => {
      const result = await service.search({
        query: "neural network",
        orientation: "portrait",
      });

      expect(result.items.length).toBeGreaterThan(0);
      const first = result.items[0]!;
      expect(first).toBeDefined();
      expect(first.title.toLowerCase()).toContain("neural network");
      expect(first.aspectRatio).toBe("9:16");
      expect(first.downloadVideoUrl).toContain(".mp4");
      expect(first.previewVideoUrl).toContain(".mp4");
      expect(result.cached).toBe(false);
    });

    it("prioritizes 9:16 vertical videos when portrait orientation is requested", async () => {
      const result = await service.search({
        query: "drone",
        orientation: "portrait",
      });

      expect(result.items.length).toBeGreaterThan(0);
      // All top items should be vertical (height >= width)
      for (const item of result.items.slice(0, 3)) {
        expect(item.height).toBeGreaterThanOrEqual(item.width);
      }
    });

    it("prioritizes 16:9 widescreen videos when landscape orientation is requested", async () => {
      const result = await service.search({
        query: "waves",
        orientation: "landscape",
      });

      expect(result.items.length).toBeGreaterThan(0);
      const first = result.items[0]!;
      expect(first.width).toBeGreaterThanOrEqual(first.height);
      expect(first.aspectRatio).toBe("16:9");
    });

    it("serves results from Redis cache when key hits", async () => {
      const cachedPayload = {
        items: [
          {
            id: "cached-1",
            provider: "storyblocks",
            title: "Cached Rocket Video",
            durationSec: 7.2,
            thumbnailUrl: "https://thumb.com",
            previewVideoUrl: "https://prev.mp4",
            downloadVideoUrl: "https://down.mp4",
            width: 1080,
            height: 1920,
          },
        ],
        total: 1,
        page: 1,
        perPage: 20,
        cached: false,
      };

      mockRedis.client.get.mockResolvedValueOnce(JSON.stringify(cachedPayload));

      const result = await service.search({ query: "rocket" });
      expect(result.cached).toBe(true);
      expect(result.items[0]?.id).toBe("cached-1");
      expect(mockRedis.client.set).not.toHaveBeenCalled();
    });

    it("saves fresh search results to Redis cache with 48h TTL on cache miss", async () => {
      mockRedis.client.get.mockResolvedValueOnce(null);

      const result = await service.search({ query: "luxury" });
      expect(result.cached).toBe(false);
      expect(mockRedis.client.set).toHaveBeenCalledWith(
        expect.stringContaining("stock:search:v1:luxury"),
        expect.any(String),
        "EX",
        REDIS_STOCK_CACHE_TTL_SEC,
      );
    });

    it("handles provider timeout or rejection gracefully without throwing", async () => {
      // Force Pexels API key to trigger external branch
      process.env["PEXELS_API_KEY"] = "mock-key";
      const customService = new StockService(
        mockPrisma as PrismaService,
        mockRedis as unknown as RedisService,
        mockRawStore as unknown as ObjectStore,
      );

      // Search should still succeed by falling back to curated library
      const result = await customService.search({ query: "finance" });
      expect(result.items.length).toBeGreaterThan(0);
      delete process.env["PEXELS_API_KEY"];
    });
  });

  describe("importOrCacheAsset() edge caching", () => {
    it("returns existing S3 cached asset without re-downloading if already in ObjectStore", async () => {
      mockRawStore.head.mockResolvedValueOnce({
        sizeBytes: 15_420_000,
        contentType: "video/mp4",
      });

      const res = await service.importOrCacheAsset({
        assetId: "sb-crypto-chart-02",
        provider: "storyblocks",
        downloadVideoUrl: "https://assets.aksharo.com/stock/videos/stock-market-charts-vertical-1080p.mp4",
        projectId: "proj-123",
      });

      expect(res.status).toBe("ready");
      expect(res.cachedKey).toBe("stock-cache/storyblocks/sb-crypto-chart-02.mp4");
      expect(res.sizeBytes).toBe(15_420_000);
      expect(mockRawStore.put).not.toHaveBeenCalled();
    });
  });
});
