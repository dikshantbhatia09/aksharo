import { describe, expect, it } from "vitest";

import { chooseShape, clock, tooLongFor, type VideoShape } from "./platforms.js";

const all = new Set<VideoShape>(["9:16", "4:5", "1:1", "16:9"]);
const none = new Set<VideoShape>();

describe("chooseShape", () => {
  it("posts vertical to Reels, Shorts, TikTok and Threads", () => {
    for (const provider of ["instagram", "youtube", "tiktok", "threads"] as const) {
      expect(chooseShape(provider, all, none).shape, provider).toBe("9:16");
    }
  });

  it("posts 4:5 to a Facebook feed, and falls back to vertical without it", () => {
    expect(chooseShape("facebook", all, none).shape).toBe("4:5");
    expect(chooseShape("facebook", new Set<VideoShape>(["9:16"]), none).shape).toBe("9:16");
  });

  it("prefers square on LinkedIn, then 4:5; square, then wide on X", () => {
    expect(chooseShape("linkedin", all, none).shape).toBe("1:1");
    expect(chooseShape("linkedin", new Set<VideoShape>(["9:16", "4:5"]), none).shape).toBe("4:5");
    expect(chooseShape("x", all, none).shape).toBe("1:1");
    expect(chooseShape("x", new Set<VideoShape>(["9:16", "16:9"]), none).shape).toBe("16:9");
  });

  it("says so when it falls back because the better shape is still being made", () => {
    const choice = chooseShape(
      "linkedin",
      new Set<VideoShape>(["9:16"]),
      new Set<VideoShape>(["1:1", "4:5"]),
    );
    expect(choice).toEqual({
      shape: "9:16",
      note: "The square video is still being made, so this posts the vertical (9:16) one.",
    });
  });

  it("has nothing to post without a finished captioned video", () => {
    expect(chooseShape("instagram", none, new Set<VideoShape>(["9:16"]))).toEqual({
      shape: null,
      note: "Its video is still being made.",
    });
    expect(chooseShape("instagram", none, none).note).toBe("No finished video with captions yet.");
  });
});

describe("tooLongFor", () => {
  it("holds X to 2:20 and Threads to 5:00, with a second of slack for the handles", () => {
    expect(tooLongFor("x", 141_000)).toBeNull();
    expect(tooLongFor("x", 150_000)).toBe("Too long for X: 2:20 at most.");
    expect(tooLongFor("threads", 179_000)).toBeNull();
    expect(tooLongFor("facebook", 170_000)).toBeNull();
    expect(tooLongFor("x", null)).toBeNull();
  });

  it("formats a clock", () => {
    expect(clock(140_000)).toBe("2:20");
    expect(clock(65_000)).toBe("1:05");
  });
});
