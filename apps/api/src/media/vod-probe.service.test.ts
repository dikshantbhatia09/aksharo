import { describe, expect, it } from "vitest";
import { VodProbeService } from "./vod-probe.service.js";

describe("VodProbeService URL parsing", () => {
  const service = new VodProbeService();

  it("parses Twitch VOD URLs correctly", () => {
    const res1 = service.parseUrl("https://www.twitch.tv/videos/2091234567");
    expect(res1).toEqual({
      platform: "TWITCH",
      vodId: "2091234567",
      normalizedUrl: "https://www.twitch.tv/videos/2091234567",
    });

    const res2 = service.parseUrl("twitch.tv/ninja");
    expect(res2?.platform).toBe("TWITCH");
    expect(res2?.vodId).toBe("ninja");
  });

  it("parses Kick VOD and channel URLs correctly", () => {
    const res1 = service.parseUrl("https://kick.com/video/582910");
    expect(res1).toEqual({
      platform: "KICK",
      vodId: "582910",
      normalizedUrl: "https://kick.com/video/582910",
    });

    const res2 = service.parseUrl("https://kick.com/xqc");
    expect(res2?.platform).toBe("KICK");
    expect(res2?.vodId).toBe("xqc");
  });

  it("parses YouTube Live URLs correctly", () => {
    const res1 = service.parseUrl("https://www.youtube.com/live/dQw4w9WgXcQ");
    expect(res1).toEqual({
      platform: "YOUTUBE_LIVE",
      vodId: "dQw4w9WgXcQ",
      normalizedUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });

    const res2 = service.parseUrl("https://youtube.com/watch?v=dQw4w9WgXcQ");
    expect(res2?.platform).toBe("YOUTUBE_LIVE");
    expect(res2?.vodId).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-supported or invalid URLs", () => {
    expect(service.parseUrl("https://vimeo.com/123456")).toBeNull();
    expect(service.parseUrl("https://example.com/video.mp4")).toBeNull();
    expect(service.parseUrl("not-a-url")).toBeNull();
  });
});

describe("VodProbeService chat analysis & spike detection", () => {
  const service = new VodProbeService();

  it("computes 5-second chat density curve and mines hype keywords", () => {
    const comments = [
      { id: "1", contentOffsetSeconds: 2, message: "Hello world" },
      { id: "2", contentOffsetSeconds: 4, message: "W stream POG" },
      { id: "3", contentOffsetSeconds: 4.5, message: "POGGERS CLIP THAT" },
      { id: "4", contentOffsetSeconds: 12, message: "GG" },
    ];

    const density = service.computeChatDensity(comments, 20, 5);
    expect(density.length).toBeGreaterThanOrEqual(3);

    // Bucket 0 (0-5s): 3 comments
    const bucket0 = density[0]!;
    expect(bucket0.timestampSec).toBe(0);
    expect(bucket0.mps).toBeCloseTo(0.6, 1);
    expect(bucket0.topKeywords).toContain("POG");

    // Bucket 2 (10-15s): 1 comment
    const bucket2 = density[2]!;
    expect(bucket2.timestampSec).toBe(10);
    expect(bucket2.mps).toBeCloseTo(0.2, 1);
  });

  it("detects high-velocity spikes where Z-score >= 2.0", () => {
    // 60 buckets (5 mins) with low baseline mps = 1, and a huge spike at bucket 30 (mps = 25)
    const buckets = Array.from({ length: 60 }, (_, idx) => ({
      timestampSec: idx * 5,
      mps: idx === 30 ? 25.0 : 1.0,
      topKeywords: idx === 30 ? ["POG", "W", "CLIP THAT"] : [],
    }));

    const peaks = service.detectSpikes(buckets, 2.0);
    expect(peaks.length).toBe(1);
    const peak = peaks[0]!;
    expect(peak.score).toBeGreaterThan(70);
    expect(peak.topEmotes).toContain("POG");
    expect(peak.topEmotes).toContain("W");
    expect(peak.startSec).toBeLessThanOrEqual(150);
    expect(peak.endSec).toBeGreaterThanOrEqual(150);
  });

  it("handles empty comments or baseline without spikes gracefully", () => {
    const peaks = service.detectSpikes([]);
    expect(peaks).toEqual([]);

    const flatBuckets = Array.from({ length: 20 }, (_, idx) => ({
      timestampSec: idx * 5,
      mps: 2.0,
      topKeywords: [],
    }));
    const flatPeaks = service.detectSpikes(flatBuckets);
    expect(flatPeaks).toEqual([]);
  });
});

describe("VodProbeService probe execution", () => {
  const service = new VodProbeService();

  it("rejects invalid URLs with badRequest exception", async () => {
    await expect(service.probe("https://example.com/not-livestream")).rejects.toThrow();
  });

  it("probes mock Twitch comments and produces valid VodProbeResponse", async () => {
    const mockComments = [
      { id: "c1", contentOffsetSeconds: 10, message: "first" },
      { id: "c2", contentOffsetSeconds: 100, message: "POG POG" },
      { id: "c3", contentOffsetSeconds: 102, message: "W W W CLIP THAT" },
      { id: "c4", contentOffsetSeconds: 103, message: "LMAO" },
      { id: "c5", contentOffsetSeconds: 104, message: "POGGERS" },
    ];

    const result = await service.probe("https://www.twitch.tv/videos/99999999", {
      mockComments,
      timeoutMs: 500,
    });

    expect(result.platform).toBe("TWITCH");
    expect(result.vodId).toBe("99999999");
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result.chatVelocity.length).toBeGreaterThan(0);
    expect(result.peaks).toBeDefined();
  });
});

