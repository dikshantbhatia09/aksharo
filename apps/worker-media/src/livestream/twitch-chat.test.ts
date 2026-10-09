import { describe, expect, it } from "vitest";
import {
  computeChatDensityCurve,
  computeStats,
  detectChatSpikes,
  analyzeTwitchVod,
  type TwitchCommentRaw,
} from "./twitch-chat.js";
import { parseLivestreamUrl, probeLivestreamVod } from "./vod-analyzer.js";

describe("Twitch Chat Sentiment & Density Miner", () => {
  const mockComments: TwitchCommentRaw[] = [
    // Baseline chat at 0-20s
    { id: "1", contentOffsetSeconds: 2, message: "hello chat" },
    { id: "2", contentOffsetSeconds: 8, message: "gg" },
    { id: "3", contentOffsetSeconds: 14, message: "hype stream" },
    // Massive explosion at 300s (5 minutes in) with W and POG
    { id: "4", contentOffsetSeconds: 300, message: "POG" },
    { id: "5", contentOffsetSeconds: 301, message: "POGGERS WHAT A PLAY" },
    { id: "6", contentOffsetSeconds: 301, message: "W" },
    { id: "7", contentOffsetSeconds: 302, message: "W W W" },
    { id: "8", contentOffsetSeconds: 302, message: "CLIP THAT" },
    { id: "9", contentOffsetSeconds: 303, message: "LMAO NO WAY" },
    { id: "10", contentOffsetSeconds: 303, message: "POG" },
    { id: "11", contentOffsetSeconds: 304, message: "WTF GOAT" },
    { id: "12", contentOffsetSeconds: 304, message: "W" },
    // Another spike at 600s (10 minutes in)
    { id: "13", contentOffsetSeconds: 600, message: "OMEGALUL" },
    { id: "14", contentOffsetSeconds: 601, message: "LMAO L" },
    { id: "15", contentOffsetSeconds: 601, message: "KEKW" },
    { id: "16", contentOffsetSeconds: 602, message: "LMAO" },
    { id: "17", contentOffsetSeconds: 603, message: "KEKW" },
    { id: "18", contentOffsetSeconds: 604, message: "NO WAY" },
  ];

  it("computes 5-second density curve and identifies top keywords", () => {
    const curve = computeChatDensityCurve(mockComments, 700, 5);
    expect(curve.length).toBeGreaterThanOrEqual(140);

    // Bucket at 300s (index 60 = 300 / 5)
    const spikeBucket = curve.find((b) => b.timestampSec === 300);
    expect(spikeBucket).toBeDefined();
    expect(spikeBucket?.messageCount).toBe(9);
    expect(spikeBucket?.mps).toBe(1.8);
    expect(spikeBucket?.topKeywords).toContain("POG");
    expect(spikeBucket?.topKeywords).toContain("W");
  });

  it("calculates mean and standard deviation accurately", () => {
    const stats = computeStats([10, 20, 30, 40, 50]);
    expect(stats.mean).toBe(30);
    expect(Math.round(stats.stdDev)).toBe(14);
  });

  it("detects viral moment windows where Z >= 2.0", () => {
    const curve = computeChatDensityCurve(mockComments, 700, 5);
    const peaks = detectChatSpikes(curve, { zThreshold: 2.0, windowRadiusSec: 30 });

    expect(peaks.length).toBeGreaterThanOrEqual(1);
    const firstPeak = peaks.find((p) => p.peakTimestampSec === 300);
    expect(firstPeak).toBeDefined();
    expect(firstPeak?.startSec).toBe(270);
    expect(firstPeak?.endSec).toBe(335);
    expect(firstPeak?.score).toBeGreaterThanOrEqual(75);
    expect(firstPeak?.topEmotes).toContain("W");
  });

  it("analyzes Twitch VOD end-to-end with mock comments", async () => {
    const result = await analyzeTwitchVod("1234567890", 7200, {
      mockComments,
    });
    expect(result.chatVelocity.length).toBeGreaterThan(0);
    expect(result.peaks.length).toBeGreaterThanOrEqual(1);
    expect(result.peaks[0]?.score).toBeGreaterThan(60);
  });

  it("parses livestream URLs for Twitch, Kick, and YouTube Live", () => {
    const twitch = parseLivestreamUrl("https://www.twitch.tv/videos/987654321");
    expect(twitch?.platform).toBe("TWITCH");
    expect(twitch?.vodId).toBe("987654321");

    const kick = parseLivestreamUrl("https://kick.com/video/abc-def-123");
    expect(kick?.platform).toBe("KICK");
    expect(kick?.vodId).toBe("abc-def-123");

    const kickChannel = parseLivestreamUrl("https://kick.com/streamer/videos/xyz-789");
    expect(kickChannel?.platform).toBe("KICK");
    expect(kickChannel?.vodId).toBe("xyz-789");

    const ytLive = parseLivestreamUrl("https://www.youtube.com/live/dQw4w9WgXcQ");
    expect(ytLive?.platform).toBe("YOUTUBE_LIVE");
    expect(ytLive?.vodId).toBe("dQw4w9WgXcQ");

    expect(parseLivestreamUrl("https://google.com/invalid")).toBeNull();
  });

  it("probes livestream VOD metadata and produces full VodProbeResponse", async () => {
    const probe = await probeLivestreamVod("https://www.twitch.tv/videos/987654321", {
      mockTwitchComments: mockComments,
    });
    expect(probe.platform).toBe("TWITCH");
    expect(probe.vodId).toBe("987654321");
    expect(probe.chatVelocity.length).toBeGreaterThan(0);
    expect(probe.peaks.length).toBeGreaterThanOrEqual(1);
  });
});

