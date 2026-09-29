import { describe, expect, it } from "vitest";

import { DEFAULT_BRAND_KIT_SETTINGS, type BrandKitSettings, type PassItem } from "@montaj/edg";

import { editorEndCardOverlay, editorLogoOverlay, endCardTail } from "./brand-overlays";
import { brandPreviewProjection, PREVIEW_DURATION_MS, previewMomentMs } from "./brand-preview";
import { logoFileProblem } from "./use-brand-kit";

import { SYSTEM_STYLE_MAP } from "@/components/editor/panels/system-styles";

const LOGO = {
  assetId: "01JL0G0A55ET00000000000000",
  format: "png",
  width: 400,
  height: 200,
} as const;

const KIT: BrandKitSettings = {
  ...DEFAULT_BRAND_KIT_SETTINGS,
  captions: { fontFamily: "Poppins", highlight: "#f0508a" },
  endCard: { ...DEFAULT_BRAND_KIT_SETTINGS.endCard, enabled: true, cta: "Follow for more" },
};

function punchPop() {
  const style = SYSTEM_STYLE_MAP.get("punch-pop");
  if (style === undefined) throw new Error("no punch-pop");
  return style;
}

describe("brandPreviewProjection", () => {
  it("draws the kit on a sample clip: captions, hook title, logo and end card", () => {
    const projection = brandPreviewProjection(KIT, LOGO, punchPop());
    expect(projection.styles.defaultStyleId).toBe("punch-pop");
    expect(projection.styles.inline?.doc).toMatchObject({
      typography: { fontFamily: "Poppins" },
      colors: { activeText: "#f0508a" },
    });
    expect(projection.segments).toHaveLength(3);
    expect(projection.segments[0]?.emphasis?.[0]?.presetId).toBe("pop");
    expect(projection.overlays?.map((overlay) => overlay.kind)).toEqual([
      "hook-title",
      "logo",
      "end-card",
    ]);
    const card = projection.overlays?.find((overlay) => overlay.kind === "end-card");
    expect(card).toMatchObject({
      startMs: PREVIEW_DURATION_MS - KIT.endCard.durationMs,
      endMs: PREVIEW_DURATION_MS,
    });
  });

  it("shows only the hook title for a kit with nothing else, and changes no caption", () => {
    const projection = brandPreviewProjection(DEFAULT_BRAND_KIT_SETTINGS, undefined, punchPop());
    expect(projection.styles.inline).toBeUndefined();
    expect(projection.overlays?.map((overlay) => overlay.kind)).toEqual(["hook-title"]);
  });

  it("jumps to the opening, the middle and inside the end card", () => {
    expect(previewMomentMs("opening", KIT)).toBeLessThan(2_500);
    const end = previewMomentMs("end", KIT);
    expect(end).toBeGreaterThan(PREVIEW_DURATION_MS - KIT.endCard.durationMs);
    expect(end).toBeLessThan(PREVIEW_DURATION_MS);
  });
});

describe("the editor's brand overlays", () => {
  const cut = (startMs: number, endMs: number): PassItem =>
    ({
      itemId: "01JCVT00000000000000000000",
      passId: "01JPASS0000000000000000000",
      kind: "cut",
      startMs,
      endMs,
      payload: {},
      state: "accepted",
    }) as PassItem;

  it("puts the end card over the last seconds of the video as cut", () => {
    expect(endCardTail([], 30_000, 3_000)).toEqual({ startMs: 27_000, endMs: 30_000 });
    expect(endCardTail([cut(28_000, 30_000)], 30_000, 3_000)).toEqual({
      startMs: 25_000,
      endMs: 30_000,
    });
    // A clip shorter than the card: all of it.
    expect(endCardTail([], 2_000, 3_000)).toEqual({ startMs: 0, endMs: 2_000 });
    expect(endCardTail([], 0, 3_000)).toBeUndefined();
  });

  it("puts back what the kit has, even where the kit adds nothing to new clips", () => {
    const hidden: BrandKitSettings = {
      ...KIT,
      logo: { ...KIT.logo, show: false },
      endCard: { ...KIT.endCard, enabled: false },
    };
    expect(editorLogoOverlay(hidden, LOGO, "01JL0G000000000000000000AA", 30_000)).toMatchObject({
      kind: "logo",
      startMs: 0,
      endMs: 30_000,
    });
    expect(
      editorEndCardOverlay(hidden, LOGO, "01JCARD0000000000000000AAA", [], 30_000),
    ).toMatchObject({ kind: "end-card", cta: "Follow for more", startMs: 27_000 });
    // Nothing to put back without a logo, or with an empty card.
    expect(editorLogoOverlay(hidden, undefined, "x", 30_000)).toBeUndefined();
    const empty = { ...KIT, endCard: { ...KIT.endCard, cta: "", handle: "", showLogo: false } };
    expect(editorEndCardOverlay(empty, LOGO, "x", [], 30_000)).toBeUndefined();
  });
});

describe("logoFileProblem", () => {
  it("takes a PNG, JPEG or WebP up to 2 MB, and says why anything else is refused", () => {
    expect(logoFileProblem({ type: "image/png", size: 10_000 })).toBeNull();
    expect(logoFileProblem({ type: "image/webp", size: 2 * 1024 * 1024 })).toBeNull();
    expect(logoFileProblem({ type: "image/svg+xml", size: 100 })).toMatch(/PNG, JPEG or WebP/);
    expect(logoFileProblem({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toMatch(/2 MB/);
    expect(logoFileProblem({ type: "image/png", size: 0 })).toMatch(/empty/);
  });
});
