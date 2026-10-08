import { describe, expect, it } from "vitest";
import {
  YouTubeNativeChapterSchema,
  YouTubeProbeRequestSchema,
  YouTubeProbeResponseSchema,
} from "./youtube.js";

describe("YouTube Ingestion Contracts", () => {
  it("validates valid probe request", () => {
    const valid = { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
    expect(YouTubeProbeRequestSchema.parse(valid)).toEqual(valid);
  });

  it("refuses empty probe url", () => {
    expect(() => YouTubeProbeRequestSchema.parse({ url: "   " })).toThrow();
  });

  it("validates full probe response with native chapters", () => {
    const response = {
      videoId: "dQw4w9WgXcQ",
      title: "Rick Astley - Never Gonna Give You Up (Official Music Video)",
      channelName: "Rick Astley",
      durationSec: 212,
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
      isLiveStream: false,
      hasCaptions: true,
      nativeChapters: [
        { title: "Intro", startSec: 0, endSec: 18 },
        { title: "Chorus 1", startSec: 18, endSec: 45 },
        { title: "Bridge", startSec: 45, endSec: 120 },
      ],
    };

    const parsed = YouTubeProbeResponseSchema.parse(response);
    expect(parsed.videoId).toBe("dQw4w9WgXcQ");
    expect(parsed.nativeChapters).toHaveLength(3);
    expect(parsed.nativeChapters[1]?.title).toBe("Chorus 1");
  });

  it("validates chapter schemas correctly", () => {
    const chapter = { title: "Introduction", startSec: 0, endSec: 30 };
    expect(YouTubeNativeChapterSchema.parse(chapter)).toEqual(chapter);
  });
});

