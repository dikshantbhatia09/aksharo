import { describe, expect, it } from "vitest";
import {
  ChatDensityBucketSchema,
  ChatPeakHighlightSchema,
  SelectedTimeRangeSchema,
  VodProbeRequestSchema,
  VodProbeResponseSchema,
  StreamVodMetadataSchema,
} from "./vod.js";

describe("VOD and livestream contracts", () => {
  it("validates valid probe request", () => {
    const parsed = VodProbeRequestSchema.parse({
      url: "https://www.twitch.tv/videos/1234567890",
    });
    expect(parsed.url).toBe("https://www.twitch.tv/videos/1234567890");
  });

  it("validates chat density bucket", () => {
    const bucket = ChatDensityBucketSchema.parse({
      timestampSec: 300,
      mps: 14.5,
      topKeywords: ["W", "POG", "CLIP THAT"],
    });
    expect(bucket.mps).toBe(14.5);
    expect(bucket.topKeywords).toContain("POG");
  });

  it("validates chat peak highlight", () => {
    const peak = ChatPeakHighlightSchema.parse({
      startSec: 1200,
      endSec: 1260,
      score: 95.5,
      topEmotes: ["POG", "OMEGALUL"],
      reason: "Z-score 3.4 chat spike",
    });
    expect(peak.score).toBe(95.5);
    expect(peak.endSec - peak.startSec).toBe(60);
  });

  it("validates full vod probe response", () => {
    const res = VodProbeResponseSchema.parse({
      platform: "TWITCH",
      vodId: "1234567890",
      title: "Championship Finals 8 Hour Marathon",
      channelName: "esports_central",
      durationSec: 28800,
      thumbnailUrl: "https://static-cdn.jtvnw.net/cf_vods/sample.jpg",
      isLive: false,
      chatVelocity: [
        { timestampSec: 0, mps: 1.2, topKeywords: ["hi"] },
        { timestampSec: 5, mps: 2.4, topKeywords: ["hype"] },
      ],
      peaks: [
        {
          startSec: 3600,
          endSec: 3660,
          score: 92,
          topEmotes: ["POG", "W"],
        },
      ],
    });
    expect(res.platform).toBe("TWITCH");
    expect(res.durationSec).toBe(28800);
    expect(res.peaks).toHaveLength(1);
  });

  it("validates StreamVodMetadata schema", () => {
    const record = StreamVodMetadataSchema.parse({
      projectId: "proj-123",
      platform: "KICK",
      vodId: "kick-vod-999",
      totalDurationSec: 14400,
      chatVelocity: [],
      selectedRanges: [{ startSec: 3600, endSec: 7200 }],
    });
    expect(record.platform).toBe("KICK");
    expect(record.selectedRanges[0]?.startSec).toBe(3600);
  });
});

