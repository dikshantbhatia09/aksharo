import { describe, expect, it } from "vitest";

import { bundleFilesOf, safeSegment, wordsToPostText } from "./run-bundle.files.js";

import type { GuestClipPlan } from "../guest/guest-files.js";

function plan(title: string, over: Partial<GuestClipPlan> = {}): GuestClipPlan {
  return {
    id: title,
    title,
    durationMs: 30_000,
    player: null,
    videos: [{ shape: "9:16", captionedKey: `ws/w/${title}/9x16.mp4`, cleanKey: null }],
    images: [],
    dubs: [],
    hashtags: [],
    posts: [],
    ...over,
  };
}

describe("safeSegment", () => {
  it("keeps a name every desktop accepts", () => {
    expect(safeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(safeSegment("ends with dots... ")).toBe("ends with dots");
    expect(safeSegment("CON")).toBe("CON_");
    expect(safeSegment("nul.txt")).toBe("nul.txt_");
    expect(safeSegment("   ")).toBe("Untitled");
    expect(safeSegment("हिंदी शीर्षक")).toBe("हिंदी शीर्षक");
    expect([...safeSegment("x".repeat(200))]).toHaveLength(60);
  });
});

describe("bundleFilesOf", () => {
  it("numbers the clips in order and keeps every path unique, case aside", () => {
    const files = bundleFilesOf({
      runTitle: "Talk",
      clips: [{ plan: plan("Same") }, { plan: plan("same") }],
      compilations: [
        { title: "Best", shape: "9:16", key: "ws/w/c1.mp4" },
        { title: "best", shape: "9:16", key: "ws/w/c2.mp4" },
      ],
      episode: null,
      includeClean: false,
    });
    expect(files.map((file) => file.path)).toEqual([
      "Talk/01 Same/Same 9x16.mp4",
      "Talk/02 same/same 9x16.mp4",
      "Talk/Compilations/Best 9x16.mp4",
      "Talk/Compilations/best 9x16 (2).mp4",
    ]);
  });

  it("marks a clean cut optional only when its captioned video is there", () => {
    const files = bundleFilesOf({
      runTitle: "Talk",
      clips: [
        {
          plan: plan("Clip", {
            videos: [
              { shape: "9:16", captionedKey: "ws/w/v.mp4", cleanKey: "ws/w/v-clean.mp4" },
              { shape: "1:1", captionedKey: null, cleanKey: "ws/w/s-clean.mp4" },
            ],
          }),
        },
      ],
      compilations: [],
      episode: null,
      includeClean: true,
    });
    expect(files.filter((file) => file.kind === "clean").map((file) => [file.path, file.optional])).toEqual([
      ["Talk/01 Clip/Without captions/Clip 9x16 no captions.mp4", true],
      ["Talk/01 Clip/Without captions/Clip 1x1 no captions.mp4", false],
    ]);
  });
});

describe("wordsToPostText", () => {
  it("has nothing to say for a clip with no words", () => {
    expect(wordsToPostText(plan("Quiet"))).toBeNull();
  });
});
