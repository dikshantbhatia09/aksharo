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
    // Shortened at a word (2026-10-01: "... Robert Greene FO5.zip").
    expect(
      safeSegment(
        "The Psychology Of Seduction: How To Become Impossible To Ignore | Robert Greene | FO565 Raj Shamani",
        80,
      ),
    ).toBe("The Psychology Of Seduction How To Become Impossible To Ignore Robert Greene");
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
      "Talk/01 Same/9x16.mp4",
      "Talk/02 same/9x16.mp4",
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
      ["Talk/01 Clip/Without captions/9x16 no captions.mp4", true],
      ["Talk/01 Clip/Without captions/1x1 no captions.mp4", false],
    ]);
  });

  it("guarantees every relative path stays strictly under MAX_PATH budget even with long titles", () => {
    const veryLongRunTitle =
      "Gemini 4, GPT 6.1, Dots, Claude Sonnet 5.5, Ideogram 4.5, Flux 3 AI NEWS and Deep Analysis of Every Frontier Release";
    const veryLongClipTitle =
      "A massive 320 billion parameter AI model breaks all benchmark records with MoE architecture";
    const files = bundleFilesOf({
      runTitle: veryLongRunTitle,
      clips: [
        {
          plan: plan(veryLongClipTitle, {
            videos: [
              { shape: "9:16", captionedKey: "ws/w/v1.mp4", cleanKey: "ws/w/v1-clean.mp4" },
            ],
            images: [
              {
                id: "carousel",
                name: "Carousel",
                keys: [{ name: "carousel-slide-1", key: "ws/w/img1.jpg" }],
              },
            ],
            dubs: [
              {
                language: "hi-IN",
                name: "Hindi Dubbed Audio Track",
                videos: [{ shape: "9:16", captionedKey: "ws/w/dub.mp4", cleanKey: null }],
              },
            ],
          }),
        },
      ],
      compilations: [
        { title: "Long Compilation Title of All Major Breakthroughs", shape: "9:16", key: "ws/w/c.mp4" },
      ],
      episode: {
        chapters: [{ startMs: 0, title: "Intro" }],
        youtubeDescription: "Desc",
        showNotes: "",
        linkedinPost: "",
        xThread: [],
        newsletter: "",
      },
      includeClean: true,
    });

    // Check that every relative path in the archive is < 120 chars (leaving 140+ chars for user's download path)
    for (const file of files) {
      expect(file.path.length).toBeLessThan(120);
    }
  });
});

describe("wordsToPostText", () => {
  it("has nothing to say for a clip with no words", () => {
    expect(wordsToPostText(plan("Quiet"))).toBeNull();
  });
});
