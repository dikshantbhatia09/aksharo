import { describe, expect, it } from "vitest";

import type { VideoShape } from "@montaj/repurpose-contracts";

import {
  fileStem,
  imageSources,
  planGuestClip,
  postsOf,
  type CaptionedVideo,
  type GuestClipInput,
} from "./guest-files.js";
import { NOT_REQUIRED, approvalCheck } from "../review/review-state.js";

const COPY = {
  summary: "Why most people never save",
  hook: "Stop doing this",
  cta: "",
  hashtags: ["#money", "#saving"],
  locale: "en",
  title: "Never save",
  description: "The one habit.",
  platforms: {
    x: { text: "One habit. #money" },
    youtube: { title: "The one habit that changes everything", description: "Watch till the end." },
    instagram: { caption: "The one habit. #money #saving" },
  },
};

function video(shape: string, n = 1): CaptionedVideo {
  const tag = shape.replace(":", "x");
  return {
    exportId: `EXP-${tag}-${String(n)}`,
    storageKey: `ws/W/p/P-${tag}/exports/EXP-${tag}-${String(n)}.mp4`,
    durationMs: 29_000,
  };
}

function input(over: Partial<GuestClipInput> = {}): GuestClipInput {
  return {
    id: "CLIP",
    title: "Never save",
    copy: COPY,
    images: {},
    durationMs: 30_000,
    captioned: new Map<VideoShape, CaptionedVideo>([
      ["9:16", video("9:16")],
      ["4:5", video("4:5")],
    ]),
    clean: new Map<VideoShape, string>([
      ["9:16", "ws/W/p/P-9x16/media/M/master.mp4"],
      ["4:5", "ws/W/p/P-4x5/media/M/master.mp4"],
      ["1:1", "ws/W/p/P-1x1/media/M/master.mp4"],
    ]),
    approval: NOT_REQUIRED,
    dubs: [],
    ...over,
  };
}

const IMAGES = {
  fingerprint: "16:9:clean:MEDIA16@30000,4:5:EXP-4x5-1,9:16:EXP-9x16-1",
  images: [
    { name: "thumbnail-1", key: "ws/W/i/thumbnail-1.jpg", width: 1280, height: 720 },
    { name: "carousel-2", key: "ws/W/i/carousel-2.jpg", width: 1080, height: 1350 },
    { name: "vertical-image-1", key: "ws/W/i/vertical-image-1.jpg", width: 1080, height: 1920 },
    { name: "carousel-1", key: "ws/W/i/carousel-1.jpg", width: 1080, height: 1350 },
    { name: "not-an-image-1", key: "ws/W/i/x.jpg", width: 1, height: 1 },
  ],
};

describe("what a guest page offers of a clip", () => {
  it("offers each shape with a captioned video or a clean cut, in shape order", () => {
    const plan = planGuestClip(input());
    expect(plan?.videos).toEqual([
      {
        shape: "9:16",
        captionedKey: video("9:16").storageKey,
        cleanKey: "ws/W/p/P-9x16/media/M/master.mp4",
      },
      {
        shape: "4:5",
        captionedKey: video("4:5").storageKey,
        cleanKey: "ws/W/p/P-4x5/media/M/master.mp4",
      },
      // A clean cut alone is still a file to download.
      { shape: "1:1", captionedKey: null, cleanKey: "ws/W/p/P-1x1/media/M/master.mp4" },
    ]);
    // The captioned 9:16 is what plays, and its length is the video's.
    expect(plan?.player).toMatchObject({
      shape: "9:16",
      key: video("9:16").storageKey,
      captioned: true,
    });
    expect(plan?.durationMs).toBe(29_000);
  });

  it("plays another captioned shape, then a clean cut, when there is no captioned 9:16", () => {
    const noVertical = planGuestClip(
      input({ captioned: new Map<VideoShape, CaptionedVideo>([["4:5", video("4:5")]]) }),
    );
    expect(noVertical?.player).toMatchObject({ shape: "4:5", captioned: true });

    const cleanOnly = planGuestClip(input({ captioned: new Map() }));
    expect(cleanOnly?.player).toEqual({
      shape: "9:16",
      key: "ws/W/p/P-9x16/media/M/master.mp4",
      captioned: false,
      posterKey: null,
    });
    expect(cleanOnly?.durationMs).toBe(30_000);
  });

  it("offers nothing, and is not a clip on the page, before it has a cut or a video", () => {
    expect(planGuestClip(input({ captioned: new Map(), clean: new Map() }))).toBeNull();
  });

  it("groups the stored images per file, in the formats' order, and shows the vertical still first", () => {
    const plan = planGuestClip(input({ images: IMAGES }));
    expect(plan?.images.map((image) => [image.id, image.keys.map((entry) => entry.name)])).toEqual([
      ["carousel", ["carousel-2", "carousel-1"]],
      ["vertical-image", ["vertical-image-1"]],
      ["thumbnail", ["thumbnail-1"]],
    ]);
    expect(plan?.player?.posterKey).toBe("ws/W/i/vertical-image-1.jpg");
  });

  it("writes the words to post: a caption for anywhere, then each platform's", () => {
    const plan = planGuestClip(input());
    expect(plan?.hashtags).toEqual(["#money", "#saving"]);
    expect(plan?.posts).toEqual([
      { platform: "any", title: "Never save", text: "The one habit.\n\n#money #saving" },
      { platform: "instagram", title: null, text: "The one habit. #money #saving" },
      {
        platform: "youtube",
        title: "The one habit that changes everything",
        text: "Watch till the end.",
      },
      { platform: "x", title: null, text: "One habit. #money" },
    ]);
    // A clip whose copy was never written has none.
    expect(postsOf({})).toEqual({ hashtags: [], posts: [] });
    // The summary stands in for a description the model did not write.
    expect(postsOf({ ...COPY, description: undefined, platforms: undefined }).posts).toEqual([
      {
        platform: "any",
        title: "Never save",
        text: "Why most people never save\n\n#money #saving",
      },
    ]);
  });

  it("names each dubbed version's language, and offers only the shapes it has", () => {
    const plan = planGuestClip(
      input({
        dubs: [
          {
            language: "hi-IN",
            shapes: new Map([
              ["9:16", { captionedKey: "ws/W/d/hi-9x16.mp4", cleanKey: null }],
              ["1:1", { captionedKey: null, cleanKey: null }],
            ]),
          },
        ],
      }),
    );
    expect(plan?.dubs).toEqual([
      {
        language: "hi-IN",
        name: "Hindi",
        videos: [{ shape: "9:16", captionedKey: "ws/W/d/hi-9x16.mp4", cleanKey: null }],
      },
    ]);
  });
});

describe("a guest page under 'clips need approval before posting'", () => {
  it("offers nothing of a clip waiting for approval, or one with changes requested", () => {
    expect(planGuestClip(input({ approval: approvalCheck(true, null) }))).toBeNull();
    expect(
      planGuestClip(
        input({
          approval: approvalCheck(true, {
            state: "changes_requested",
            videos: { "9:16": "EXP-9x16-1" },
          }),
        }),
      ),
    ).toBeNull();
  });

  it("offers only the shapes the approval covers, each with its own clean cut", () => {
    const plan = planGuestClip(
      input({
        approval: approvalCheck(true, { state: "approved", videos: { "9:16": "EXP-9x16-1" } }),
        dubs: [
          {
            language: "ta-IN",
            shapes: new Map([["9:16", { captionedKey: "ws/W/d/ta.mp4", cleanKey: null }]]),
          },
        ],
      }),
    );
    // 4:5 was made after the approval; the 1:1 clean cut has no approved video.
    expect(plan?.videos).toEqual([
      {
        shape: "9:16",
        captionedKey: video("9:16").storageKey,
        cleanKey: "ws/W/p/P-9x16/media/M/master.mp4",
      },
    ]);
    // The dubbed versions of an approved clip come with it.
    expect(plan?.dubs.map((dub) => dub.language)).toEqual(["ta-IN"]);
  });

  it("refuses a video replaced since its approval", () => {
    const plan = planGuestClip(
      input({
        captioned: new Map<VideoShape, CaptionedVideo>([["9:16", video("9:16", 2)]]),
        approval: approvalCheck(true, { state: "approved", videos: { "9:16": "EXP-9x16-1" } }),
      }),
    );
    expect(plan).toBeNull();
  });

  it("offers the images only when every video they were taken from is approved", () => {
    const both = approvalCheck(true, {
      state: "approved",
      videos: { "9:16": "EXP-9x16-1", "4:5": "EXP-4x5-1", "16:9": "EXP-16x9-1" },
    });
    const covered = planGuestClip(
      input({
        images: IMAGES,
        approval: both,
        captioned: new Map<VideoShape, CaptionedVideo>([
          ["9:16", video("9:16")],
          ["4:5", video("4:5")],
          ["16:9", video("16:9")],
        ]),
      }),
    );
    expect(covered?.images.length).toBe(3);

    // The 4:5 frames came from a video the approval does not cover.
    const partial = planGuestClip(
      input({
        images: IMAGES,
        approval: approvalCheck(true, { state: "approved", videos: { "9:16": "EXP-9x16-1" } }),
      }),
    );
    expect(partial?.images).toEqual([]);
    expect(partial?.player?.posterKey).toBeNull();
  });
});

describe("reading an image set's fingerprint", () => {
  it("names the exports its frames came from and the shapes of its clean frames", () => {
    expect(imageSources(IMAGES.fingerprint)).toEqual({
      exportIds: ["EXP-4x5-1", "EXP-9x16-1"],
      cleanShapes: ["16:9"],
    });
    expect(imageSources("")).toEqual({ exportIds: [], cleanShapes: [] });
    expect(imageSources("3:2:EXP")).toEqual({ exportIds: [], cleanShapes: [] });
  });
});

describe("a downloaded file's name", () => {
  it("is the clip's title and what the file is", () => {
    expect(fileStem("Never save", "9x16", "Hindi")).toBe("Never save 9x16 Hindi");
    expect(fileStem("   ", "9x16")).toBe("clip 9x16");
    expect(fileStem("x".repeat(100)).length).toBe(70);
  });
});
