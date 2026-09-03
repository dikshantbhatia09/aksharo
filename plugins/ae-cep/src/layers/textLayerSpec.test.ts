import { describe, expect, it } from "vitest";

import { loadSystemStyles } from "@montaj/caption-styles";

import {
  buildTextLayerSpecs,
  hexToRgb,
  resolveFontSizePx,
  resolvePositionPx,
} from "./textLayerSpec.js";

const SUBTITLE_CLASSIC = loadSystemStyles().find((s) => s.id === "subtitle-classic")!;
const BOX_BLOCK = loadSystemStyles().find((s) => s.id === "box-block")!;

describe("hexToRgb", () => {
  it("parses #RRGGBB", () => {
    expect(hexToRgb("#ffffff")).toEqual([255, 255, 255]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    expect(hexToRgb("#ffd400")).toEqual([255, 212, 0]);
  });

  it("parses #RRGGBBAA, dropping alpha", () => {
    expect(hexToRgb("#ff000080")).toEqual([255, 0, 0]);
  });

  it("throws on an invalid colour", () => {
    expect(() => hexToRgb("not-a-color")).toThrow(/invalid colour/);
  });
});

describe("resolvePositionPx / resolveFontSizePx", () => {
  it("resolves layout.x/y (0-1) to comp pixels", () => {
    const pos = resolvePositionPx(SUBTITLE_CLASSIC, 1080, 1920);
    expect(pos).toEqual({ x: 0.5 * 1080, y: 0.9 * 1920 });
  });

  it("resolves typography.sizePct (percent of comp height) to pixels", () => {
    expect(resolveFontSizePx(SUBTITLE_CLASSIC, 1920)).toBeCloseTo((3.6 / 100) * 1920);
  });
});

describe("buildTextLayerSpecs", () => {
  const segments = [
    { segmentId: "seg-1", text: "Hello world", startSeconds: 0, endSeconds: 2 },
    { segmentId: "seg-2", text: "Second line", startSeconds: 2, endSeconds: 4.5 },
  ];

  it("builds one spec per segment sharing the style's font/size/colour/position", () => {
    const specs = buildTextLayerSpecs({
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUBTITLE_CLASSIC,
      segments,
    });
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({
      segmentId: "seg-1",
      text: "Hello world",
      startSeconds: 0,
      durationSeconds: 2,
      fontFamily: "Inter",
      colorRgb: [255, 255, 255],
      positionXPx: 540,
      positionYPx: 1728,
    });
    expect(specs[1]).toMatchObject({
      segmentId: "seg-2",
      startSeconds: 2,
      durationSeconds: 2.5,
    });
  });

  it("includes stroke when the style's stroke is enabled", () => {
    const specResult = buildTextLayerSpecs({
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUBTITLE_CLASSIC,
      segments: [segments[0]!],
    });
    expect(specResult[0]!.strokeColorRgb).toEqual([0, 0, 0]);
    expect(specResult[0]!.strokeWidthPx).toBeCloseTo(
      (5 / 100) * resolveFontSizePx(SUBTITLE_CLASSIC, 1920),
    );
  });

  it("omits box when the style's box is disabled", () => {
    const specResult = buildTextLayerSpecs({
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: SUBTITLE_CLASSIC,
      segments: [segments[0]!],
    });
    expect(specResult[0]!.box).toBeUndefined();
  });

  it("includes box when the style's box is enabled with a fill colour", () => {
    expect(BOX_BLOCK.box.enabled).toBe(true);
    const specResult = buildTextLayerSpecs({
      compWidthPx: 1080,
      compHeightPx: 1920,
      style: BOX_BLOCK,
      segments: [segments[0]!],
    });
    expect(specResult[0]!.box).toBeDefined();
    expect(specResult[0]!.box?.opacity).toBe(BOX_BLOCK.box.opacity);
  });
});
