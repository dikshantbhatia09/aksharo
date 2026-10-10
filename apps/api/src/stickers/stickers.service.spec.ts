import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURATED_STICKERS_MEMES_LIBRARY,
  StickersService,
} from "./stickers.service.js";
import type { PrismaService } from "../common/index.js";
import type { RedisService } from "../common/redis/redis.service.js";
import type { ObjectStore } from "../common/storage/object-store.js";

describe("StickersService", () => {
  let service: StickersService;
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
  };

  beforeEach(() => {
    mockPrisma = {};
    mockRedis = {
      client: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue("OK"),
      },
    };
    mockRawStore = {
      head: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    };

    service = new StickersService(
      mockPrisma as PrismaService,
      mockRedis as unknown as RedisService,
      mockRawStore as unknown as ObjectStore,
    );
  });

  describe("getCategories()", () => {
    it("returns standard curated discovery categories", () => {
      const categories = service.getCategories();
      expect(categories).toContain("Shocked Reactions");
      expect(categories).toContain("Arrows & Pointers");
      expect(categories).toContain("Viral Memes");
      expect(categories).toContain("Laughing & LOL");
      expect(categories).toContain("Money & Flex");
    });
  });

  describe("search()", () => {
    it("returns curated reaction meme results when matching query keywords", async () => {
      const result = await service.search({
        query: "nick young",
      });

      expect(result.assets.length).toBeGreaterThan(0);
      const nick = result.assets.find((a) => a.id === "meme-confused-nick-young");
      expect(nick).toBeDefined();
      expect(nick?.title).toContain("Confused Nick Young");
      expect(nick?.provider).toBe("curated");
      expect(nick?.type).toBe("meme");
      expect(result.categories.length).toBeGreaterThan(0);
    });

    it("filters stickers by type 'sticker' with alpha transparency", async () => {
      const result = await service.search({
        query: "arrow",
        type: "sticker",
      });

      expect(result.assets.length).toBeGreaterThan(0);
      for (const asset of result.assets) {
        expect(asset.type).toBe("sticker");
        expect(asset.isTransparent).toBe(true);
      }
    });

    it("returns cached search results from Redis when available", async () => {
      const cachedPayload = {
        assets: [CURATED_STICKERS_MEMES_LIBRARY[0]!],
        total: 1,
        page: 1,
        limit: 24,
        categories: ["All"],
      };
      mockRedis.client.get.mockResolvedValueOnce(JSON.stringify(cachedPayload));

      const result = await service.search({
        query: "cached-test",
      });

      expect(result).toEqual(cachedPayload);
      expect(mockRedis.client.get).toHaveBeenCalled();
    });

    it("handles empty query by returning all items paged", async () => {
      const result = await service.search({
        limit: 5,
        offset: 0,
      });

      expect(result.assets.length).toBe(5);
      expect(result.total).toBe(CURATED_STICKERS_MEMES_LIBRARY.length);
      expect(result.page).toBe(1);
    });
  });

  describe("getTrending()", () => {
    it("returns viral trending meme and sticker assets", async () => {
      const result = await service.getTrending({
        limit: 10,
      });

      expect(result.assets.length).toBe(10);
      expect(result.assets.some((a) => a.type === "meme")).toBe(true);
      expect(result.assets.some((a) => a.type === "sticker")).toBe(true);
    });
  });

  describe("recommendReactionMemes()", () => {
    it("proposes Steve Harvey or Mind Blown for shocked/unbelievable speech", () => {
      const res = service.recommendReactionMemes({
        transcript: "This is completely unbelievable, wait what, are you serious?",
      });

      expect(res.recommendations.length).toBeGreaterThan(0);
      const hasShocked = res.recommendations.some(
        (r) => r.sentiment === "shocked" || r.sticker.id.includes("shocked"),
      );
      expect(hasShocked).toBe(true);
    });

    it("proposes Michael Jordan or Skull Dead for humor/laughing punchline", () => {
      const res = service.recommendReactionMemes({
        transcript: "That joke was so funny haha I am literally dead laughing lol",
      });

      expect(res.recommendations.length).toBeGreaterThan(0);
      const hasHumor = res.recommendations.some(
        (r) => r.sentiment === "funny" || r.sticker.id.includes("laughing") || r.sticker.id.includes("skull"),
      );
      expect(hasHumor).toBe(true);
    });

    it("proposes Pedro Pascal crying for ironic mistake/fail", () => {
      const res = service.recommendReactionMemes({
        transcript: "That was the biggest mistake of my life, total fail",
      });

      expect(res.recommendations.length).toBeGreaterThan(0);
      const hasFail = res.recommendations.some(
        (r) => r.sentiment === "fail" || r.sticker.id.includes("pedro-pascal"),
      );
      expect(hasFail).toBe(true);
    });

    it("proposes falling cash for money/wealth topics", () => {
      const res = service.recommendReactionMemes({
        transcript: "We made thousands of dollars in profit, pure cash flow",
      });

      expect(res.recommendations.length).toBeGreaterThan(0);
      const hasMoney = res.recommendations.some((r) => r.sticker.id.includes("money"));
      expect(hasMoney).toBe(true);
    });

    it("proposes animated red arrow when speaker directs attention", () => {
      const res = service.recommendReactionMemes({
        transcript: "Look at this chart right here, notice how the numbers jump",
      });

      expect(res.recommendations.length).toBeGreaterThan(0);
      const hasArrow = res.recommendations.some((r) => r.sticker.id.includes("arrow"));
      expect(hasArrow).toBe(true);
    });
  });

  describe("cacheStickerAsset()", () => {
    it("generates S3 storage key with appropriate extension and returns cachedUrl", async () => {
      const result = await service.cacheStickerAsset({
        assetId: "arrow-01",
        provider: "curated",
        type: "sticker",
        sourceUrl: "https://media.giphy.com/media/dummy/giphy.gif",
        isTransparent: true,
      });

      expect(result.cachedKey).toBe("stickers/curated/arrow-01.webm");
      expect(result.cachedUrl).toContain("stickers/curated/arrow-01.webm");
      expect(result.isTransparent).toBe(true);
      expect(result.format).toBe("webm");
    });
  });
});
