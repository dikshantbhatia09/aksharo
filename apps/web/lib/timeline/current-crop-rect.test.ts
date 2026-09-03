import { describe, expect, it } from "vitest";

import { encodeKeyframes, type PassItem } from "@montaj/edg";

import { activeCropItem, currentCropRect } from "./current-crop-rect.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function zoomItem(overrides: Partial<PassItem> = {}): PassItem {
  const keyframes = bytesToBase64(
    encodeKeyframes([
      { tMs: 0, zoom: 1, cx: 0.5, cy: 0.5, ease: "linear" },
      { tMs: 1_000, zoom: 2, cx: 0.5, cy: 0.5, ease: "linear" },
    ]),
  );
  return {
    itemId: "item-1",
    passId: "pass-1",
    kind: "zoom",
    startMs: 2_000,
    endMs: 3_000,
    state: "accepted",
    payload: {
      target: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
      scaleFrom: 1,
      scaleTo: 2,
      easing: "easeInOut",
      keyframes,
    },
    ...overrides,
  } as PassItem;
}

describe("activeCropItem", () => {
  it("finds the accepted zoom/reframe item covering the given instant", () => {
    const item = zoomItem();
    expect(activeCropItem([item], 2_500)?.itemId).toBe("item-1");
  });

  it("ignores a proposed item", () => {
    const item = zoomItem({ state: "proposed" });
    expect(activeCropItem([item], 2_500)).toBeUndefined();
  });

  it("ignores an instant outside the item's range", () => {
    const item = zoomItem();
    expect(activeCropItem([item], 10_000)).toBeUndefined();
  });

  it("ignores a cut item", () => {
    const item = { ...zoomItem(), kind: "cut" as const, payload: {} };
    expect(activeCropItem([item], 2_500)).toBeUndefined();
  });
});

describe("currentCropRect", () => {
  it("samples the item's curve at the relative offset", () => {
    const item = zoomItem();
    const rect = currentCropRect([item], 2_500); // 500ms into the item, midpoint of the ramp
    expect(rect).not.toBeNull();
    // Halfway between zoom 1 (full frame) and zoom 2 (half frame centred).
    expect(rect?.w).toBeCloseTo(0.75, 5);
  });

  it("is null when nothing covers the instant", () => {
    const item = zoomItem();
    expect(currentCropRect([item], 10_000)).toBeNull();
  });

  it("is null for a keyframesRef item (no bytes to decode here)", () => {
    const item = zoomItem({
      payload: {
        target: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
        scaleFrom: 1,
        scaleTo: 2,
        easing: "easeInOut",
        keyframesRef: "ws/w/passes/p/item-1.mkf",
      },
    });
    expect(currentCropRect([item], 2_500)).toBeNull();
  });
});
