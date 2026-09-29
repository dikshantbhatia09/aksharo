import { describe, expect, it } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS, type BrandKitSettings } from "@montaj/edg";

import {
  DEFAULT_INTRO_COLOURS,
  captionedVideoOf,
  clipIdsOf,
  compilationFailureOf,
  compilationFingerprint,
  introOf,
  plannedDurationMs,
  sourcesChanged,
  storedSourcesOf,
  titleOf,
  type ClipWithShapes,
  type ShapeVideo,
} from "./compilation-plan.js";
import { COMPILATION_ERRORS } from "./compilations.dto.js";

const CLIP_A = "01JCC11PA00000000000000000";
const CLIP_B = "01JCC11PB00000000000000000";
const EXPORT_A = "01JCEXP0RTA000000000000000";

function clip(overrides: Partial<ClipWithShapes> = {}): ClipWithShapes {
  return {
    id: CLIP_A,
    candidate: { state: "materialized" },
    variants: [
      {
        aspect: "r9x16",
        status: "ready",
        latestExport: {
          id: EXPORT_A,
          status: "succeeded",
          storageKey: `ws/W/p/P/exports/${EXPORT_A}.mp4`,
          durationMs: 31_500,
          watermarked: true,
        },
      },
      {
        aspect: "r1x1",
        status: "rendering",
        latestExport: {
          id: "01JCEXP0RTB000000000000000",
          status: "rendering",
          storageKey: null,
          durationMs: null,
          watermarked: true,
        },
      },
    ],
    ...overrides,
  };
}

describe("titleOf", () => {
  it("collapses spaces, and an empty title is no card", () => {
    expect(titleOf("  Best   of\nthe week ")).toBe("Best of the week");
    expect(titleOf("   ")).toBeNull();
    expect(titleOf(undefined)).toBeNull();
  });
});

describe("compilationFingerprint", () => {
  it("is the same for the same clips, shape and title, and differs when any changes", () => {
    const base = { clipIds: [CLIP_A, CLIP_B], shape: "9:16" as const, title: "Best of" };
    expect(compilationFingerprint(base)).toBe(compilationFingerprint({ ...base }));
    expect(compilationFingerprint(base)).toMatch(/^[a-f0-9]{64}$/);
    for (const other of [
      { ...base, clipIds: [CLIP_B, CLIP_A] },
      { ...base, clipIds: [CLIP_A] },
      { ...base, shape: "1:1" as const },
      { ...base, title: null },
      { ...base, title: "Best of!" },
    ]) {
      expect(compilationFingerprint(other)).not.toBe(compilationFingerprint(base));
    }
  });
});

describe("captionedVideoOf", () => {
  it("joins a shape whose captioned video is made and stored", () => {
    expect(captionedVideoOf(clip(), "9:16")).toEqual({
      clipId: CLIP_A,
      exportId: EXPORT_A,
      key: `ws/W/p/P/exports/${EXPORT_A}.mp4`,
      durationMs: 31_500,
      watermarked: true,
    });
  });

  it("does not join a shape still being made, missing, expired, or a removed moment's", () => {
    expect(captionedVideoOf(clip(), "1:1")).toBeNull();
    expect(captionedVideoOf(clip(), "16:9")).toBeNull();
    const [vertical] = clip().variants;
    const expired = clip({
      variants: [{ ...vertical!, latestExport: { ...vertical!.latestExport!, storageKey: null } }],
    });
    expect(captionedVideoOf(expired, "9:16")).toBeNull();
    const stale = clip({ variants: [{ ...vertical!, status: "stale" }] });
    expect(captionedVideoOf(stale, "9:16")).toBeNull();
    expect(captionedVideoOf(clip({ candidate: { state: "rejected" } }), "9:16")).toBeNull();
  });
});

describe("plannedDurationMs", () => {
  it("is the clips, the card when there is one, less a fade a join", () => {
    const videos = [{ durationMs: 31_500 }, { durationMs: 28_000 }];
    expect(plannedDurationMs(videos, null)).toBe(59_000);
    expect(plannedDurationMs(videos, "Best of")).toBe(60_500);
  });
});

describe("introOf", () => {
  it("is the title in the product's colours without a brand kit", () => {
    expect(introOf("Best of", null)).toEqual({
      title: "Best of",
      durationMs: 2_000,
      ...DEFAULT_INTRO_COLOURS,
    });
  });

  it("wears the kit's card colour, words, handle, typeface and logo", () => {
    const settings: BrandKitSettings = {
      ...DEFAULT_BRAND_KIT_SETTINGS,
      colors: { primary: "#f0508a", secondary: "#141217", text: "#ffffff" },
      hookTitle: { fontFamily: "Poppins" },
      endCard: { ...DEFAULT_BRAND_KIT_SETTINGS.endCard, background: "#101010", handle: " @me " },
    };
    const logo = {
      assetId: "01JCASSET00000000000000000",
      format: "png" as const,
      width: 40,
      height: 20,
    };
    expect(introOf("Best of", { settings, logo })).toEqual({
      title: "Best of",
      durationMs: 2_000,
      background: "#101010",
      text: "#ffffff",
      accent: "#f0508a",
      handle: "@me",
      fontFamily: "Poppins",
      logo,
    });
  });

  it("leaves a colour that would not read to render-core's black or white", () => {
    const settings: BrandKitSettings = {
      ...DEFAULT_BRAND_KIT_SETTINGS,
      colors: { primary: "#fefefe", secondary: "#141217", text: "#f0f0f0" },
      endCard: { ...DEFAULT_BRAND_KIT_SETTINGS.endCard, background: "#ffffff" },
    };
    const intro = introOf("Best of", { settings });
    expect(intro.text).toBeUndefined();
    expect(intro.accent).toBeUndefined();
    expect(intro.handle).toBeUndefined();
    expect(intro.logo).toBeUndefined();
  });
});

describe("compilationFailureOf", () => {
  it("names each ending in words the page has", () => {
    expect(compilationFailureOf("storage/unreadable")).toBe(COMPILATION_ERRORS.sourceGone);
    expect(compilationFailureOf("render/compilation-too-long")).toBe(COMPILATION_ERRORS.tooLong);
    expect(compilationFailureOf("jobs/cancelled")).toBe(COMPILATION_ERRORS.cancelled);
    expect(compilationFailureOf("jobs/stalled")).toBe(COMPILATION_ERRORS.stalled);
    expect(compilationFailureOf("credits/insufficient")).toBe(COMPILATION_ERRORS.noCredits);
    expect(compilationFailureOf("render/ffmpeg-failed")).toBe(COMPILATION_ERRORS.failed);
    expect(compilationFailureOf(undefined)).toBe(COMPILATION_ERRORS.failed);
  });
});

describe("stored rows", () => {
  it("reads the clip ids and sources back, skipping anything malformed", () => {
    expect(clipIdsOf([CLIP_A, 7, CLIP_B])).toEqual([CLIP_A, CLIP_B]);
    expect(clipIdsOf("x")).toEqual([]);
    expect(
      storedSourcesOf([{ clipId: CLIP_A, exportId: EXPORT_A, durationMs: 1 }, { clipId: 3 }]),
    ).toEqual([{ clipId: CLIP_A, exportId: EXPORT_A, durationMs: 1 }]);
  });

  it("sees a clip whose captioned video is another file now, or none", () => {
    const sources = [{ clipId: CLIP_A, exportId: EXPORT_A, durationMs: 1 }];
    const same = new Map<string, ShapeVideo | null>([
      [CLIP_A, { clipId: CLIP_A, exportId: EXPORT_A, key: "k", durationMs: 1, watermarked: false }],
    ]);
    expect(sourcesChanged(sources, same)).toBe(false);
    const remade = new Map<string, ShapeVideo | null>([
      [CLIP_A, { clipId: CLIP_A, exportId: "other", key: "k", durationMs: 1, watermarked: false }],
    ]);
    expect(sourcesChanged(sources, remade)).toBe(true);
    expect(sourcesChanged(sources, new Map([[CLIP_A, null]]))).toBe(true);
  });
});
