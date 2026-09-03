import { describe, expect, it } from "vitest";

import { scrubPreviewMode, scrubPreviewWindow } from "./scrub-preview.js";

describe("scrubPreviewWindow", () => {
  it("centres a ±1.5s window on the playhead", () => {
    expect(scrubPreviewWindow(5_000, 20_000)).toEqual({
      startMs: 3_500,
      endMs: 6_500,
      centerMs: 5_000,
    });
  });

  it("clamps the start at 0 near the beginning of the media", () => {
    expect(scrubPreviewWindow(500, 20_000)).toEqual({ startMs: 0, endMs: 2_000, centerMs: 500 });
  });

  it("clamps the end at durationMs near the end of the media", () => {
    expect(scrubPreviewWindow(19_800, 20_000)).toEqual({
      startMs: 18_300,
      endMs: 20_000,
      centerMs: 19_800,
    });
  });

  it("never inverts on a media shorter than the full window", () => {
    const window = scrubPreviewWindow(400, 800);
    expect(window.startMs).toBeLessThanOrEqual(window.endMs);
  });

  it("accepts a custom half-window", () => {
    expect(scrubPreviewWindow(1_000, 10_000, 200)).toEqual({
      startMs: 800,
      endMs: 1_200,
      centerMs: 1_000,
    });
  });
});

describe("scrubPreviewMode", () => {
  it("prefers real frames when CanvasKit is ready", () => {
    expect(scrubPreviewMode(true)).toBe("frames");
  });

  it("falls back to the crop rectangle only otherwise", () => {
    expect(scrubPreviewMode(false)).toBe("rect-only");
  });
});
