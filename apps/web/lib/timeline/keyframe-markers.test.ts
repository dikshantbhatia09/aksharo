import { describe, expect, it } from "vitest";

import { encodeKeyframes } from "@montaj/edg";

import { decodeItemKeyframes, keyframeMarkersOf, zoomMiniPlotPoints } from "./keyframe-markers.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("keyframeMarkersOf", () => {
  it("offsets each keyframe's tMs by the item's startMs and sorts by time", () => {
    const markers = keyframeMarkersOf(
      [
        { tMs: 1_000, zoom: 1.3, cx: 0.5, cy: 0.5, ease: "linear" },
        { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
      ],
      2_000,
    );
    expect(markers).toEqual([
      { tMs: 2_000, zoom: 1 },
      { tMs: 3_000, zoom: 1.3 },
    ]);
  });

  it("is empty for an item with no keyframes", () => {
    expect(keyframeMarkersOf([], 0)).toEqual([]);
  });
});

describe("zoomMiniPlotPoints", () => {
  it("maps time linearly onto the plot width and zoom onto its height, inverted", () => {
    const markers = keyframeMarkersOf(
      [
        { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
        { tMs: 1_000, zoom: 1.5, cx: 0.5, cy: 0.5, ease: "linear" },
      ],
      0,
    );
    const points = zoomMiniPlotPoints(
      markers,
      { startMs: 0, endMs: 1_000 },
      { widthPx: 100, heightPx: 20 },
    );
    expect(points).toEqual([
      { x: 0, y: 20 }, // lowest zoom -> plot bottom
      { x: 100, y: 0 }, // highest zoom -> plot top
    ]);
  });

  it("draws a flat mid-height line when every keyframe has the same zoom", () => {
    const markers = keyframeMarkersOf(
      [
        { tMs: 0, zoom: 1.2, cx: 0.5, cy: 0.5, ease: "linear" },
        { tMs: 500, zoom: 1.2, cx: 0.5, cy: 0.5, ease: "linear" },
      ],
      0,
    );
    const points = zoomMiniPlotPoints(
      markers,
      { startMs: 0, endMs: 500 },
      { widthPx: 50, heightPx: 10 },
    );
    expect(points.every((p) => p.y === 5)).toBe(true);
  });

  it("is empty with no markers", () => {
    expect(
      zoomMiniPlotPoints([], { startMs: 0, endMs: 1_000 }, { widthPx: 10, heightPx: 10 }),
    ).toEqual([]);
  });
});

describe("decodeItemKeyframes", () => {
  it("decodes an inline base64 curve", () => {
    const keyframes = bytesToBase64(
      encodeKeyframes([{ tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" }]),
    );
    const frames = decodeItemKeyframes({ keyframes });
    expect(frames).toHaveLength(1);
    expect(frames?.[0]).toMatchObject({ tMs: 0, zoom: 1 });
  });

  it("is undefined for a keyframesRef item (no bytes to decode)", () => {
    expect(decodeItemKeyframes({ keyframesRef: "ws/w/passes/p/item.mkf" })).toBeUndefined();
  });

  it("is undefined for a payload with no curve at all (e.g. a cut item)", () => {
    expect(decodeItemKeyframes({})).toBeUndefined();
  });

  it("is undefined for malformed base64 rather than throwing", () => {
    expect(decodeItemKeyframes({ keyframes: "not-valid-mkf2" })).toBeUndefined();
  });
});
