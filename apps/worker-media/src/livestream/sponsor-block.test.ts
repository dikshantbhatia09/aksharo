import { describe, expect, it, vi } from "vitest";
import {
  extractYouTubeVideoId,
  fetchSponsorSegments,
  isYouTubeSource,
  sponsorSegmentsToExcludeRanges,
  SPONSORBLOCK_CACHE_TTL_SEC,
  type SponsorBlockRedisClient,
  type SponsorBlockSegment,
} from "./sponsor-block.js";

describe("SponsorBlock Client (Pillar 2 §04)", () => {
  describe("extractYouTubeVideoId & isYouTubeSource", () => {
    it("extracts 11-char ID from raw ID string", () => {
      expect(extractYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
      expect(isYouTubeSource("dQw4w9WgXcQ")).toBe(true);
    });

    it("extracts ID from standard watch URL", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).toBe("dQw4w9WgXcQ");
      expect(
        extractYouTubeVideoId("https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s"),
      ).toBe("dQw4w9WgXcQ");
    });

    it("extracts ID from youtu.be short URL", () => {
      expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe(
        "dQw4w9WgXcQ",
      );
    });

    it("extracts ID from live and shorts URLs", () => {
      expect(
        extractYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ"),
      ).toBe("dQw4w9WgXcQ");
      expect(
        extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
      ).toBe("dQw4w9WgXcQ");
    });

    it("returns null for non-YouTube URLs or invalid strings", () => {
      expect(extractYouTubeVideoId("https://vimeo.com/123456789")).toBeNull();
      expect(extractYouTubeVideoId("https://twitch.tv/videos/12345")).toBeNull();
      expect(extractYouTubeVideoId("not-a-valid-id")).toBeNull();
      expect(extractYouTubeVideoId("")).toBeNull();
      expect(isYouTubeSource("https://twitch.tv/videos/12345")).toBe(false);
    });
  });

  describe("fetchSponsorSegments", () => {
    it("returns cached segments from Redis on cache hit", async () => {
      const mockSegments: SponsorBlockSegment[] = [
        {
          category: "sponsor",
          startSec: 120.5,
          endSec: 180.5,
          startMs: 120500,
          endMs: 180500,
          actionType: "skip",
          uuid: "test-uuid-1",
        },
      ];

      const mockRedis: SponsorBlockRedisClient = {
        get: vi.fn(async () => JSON.stringify(mockSegments)),
        set: vi.fn(async () => "OK"),
      };

      const fetchFn = vi.fn();

      const result = await fetchSponsorSegments("dQw4w9WgXcQ", {
        redis: mockRedis,
        fetchFn: fetchFn as any,
      });

      expect(mockRedis.get).toHaveBeenCalledWith("sponsorblock:dQw4w9WgXcQ");
      expect(fetchFn).not.toHaveBeenCalled();
      expect(result).toEqual(mockSegments);
    });

    it("fetches segments from SponsorBlock API on cache miss and stores in Redis", async () => {
      const apiResponse = [
        {
          category: "sponsor",
          segment: [65.2, 125.8],
          UUID: "uuid-abc",
          actionType: "skip",
          votes: 14,
        },
        {
          category: "outro",
          segment: [540.0, 560.0],
          UUID: "uuid-def",
          actionType: "skip",
          votes: 8,
        },
      ];

      const mockRedis: SponsorBlockRedisClient = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => "OK"),
      };

      const mockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => apiResponse,
      }));

      const result = await fetchSponsorSegments(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        {
          redis: mockRedis,
          fetchFn: mockFetch as any,
        },
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        category: "sponsor",
        startSec: 65.2,
        endSec: 125.8,
        startMs: 65200,
        endMs: 125800,
        actionType: "skip",
        uuid: "uuid-abc",
        votes: 14,
      });
      expect(result[1]).toEqual({
        category: "outro",
        startSec: 540.0,
        endSec: 560.0,
        startMs: 540000,
        endMs: 560000,
        actionType: "skip",
        uuid: "uuid-def",
        votes: 8,
      });

      expect(mockRedis.set).toHaveBeenCalledWith(
        "sponsorblock:dQw4w9WgXcQ",
        JSON.stringify(result),
        "EX",
        SPONSORBLOCK_CACHE_TTL_SEC,
      );
    });

    it("handles 404 response cleanly as empty segments list and caches negative result", async () => {
      const mockRedis: SponsorBlockRedisClient = {
        get: vi.fn(async () => null),
        set: vi.fn(async () => "OK"),
      };

      const mockFetch = vi.fn(async () => ({
        ok: false,
        status: 404,
      }));

      const result = await fetchSponsorSegments("dQw4w9WgXcQ", {
        redis: mockRedis,
        fetchFn: mockFetch as any,
      });

      expect(result).toEqual([]);
      expect(mockRedis.set).toHaveBeenCalledWith(
        "sponsorblock:dQw4w9WgXcQ",
        JSON.stringify([]),
        "EX",
        86400,
      );
    });

    it("handles network failure gracefully without throwing", async () => {
      const mockFetch = vi.fn(async () => {
        throw new Error("Network unreachable");
      });

      const result = await fetchSponsorSegments("dQw4w9WgXcQ", {
        fetchFn: mockFetch as any,
      });

      expect(result).toEqual([]);
    });

    it("returns empty array for invalid YouTube IDs immediately", async () => {
      const fetchFn = vi.fn();
      const result = await fetchSponsorSegments("not-a-valid-youtube-url", {
        fetchFn: fetchFn as any,
      });
      expect(result).toEqual([]);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe("sponsorSegmentsToExcludeRanges", () => {
    it("converts SponsorBlock segments into millisecond interval ranges", () => {
      const segments: SponsorBlockSegment[] = [
        {
          category: "sponsor",
          startSec: 10,
          endSec: 45,
          startMs: 10000,
          endMs: 45000,
          actionType: "skip",
        },
        {
          category: "outro",
          startSec: 300,
          endSec: 320,
          startMs: 300000,
          endMs: 320000,
          actionType: "skip",
        },
      ];

      const ranges = sponsorSegmentsToExcludeRanges(segments);
      expect(ranges).toEqual([
        { startMs: 10000, endMs: 45000 },
        { startMs: 300000, endMs: 320000 },
      ]);
    });
  });
});
