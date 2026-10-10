import { describe, expect, it } from "vitest";

import {
  BrollOverlay,
  DEFAULT_BROLL_DISSOLVE_SEC,
  buildBrollFfmpegFiltergraph,
  computeBrollDissolveOpacity,
  computeBrollKenBurnsTransform,
  findVNodeByTestId,
  findVNodesByType,
} from "./BrollOverlay.js";

describe("BrollOverlay Component & Compositor (Pillar 6 §01)", () => {
  it("renders 3 distinct layers with audio muted and subtitles on top", () => {
    const vnode = BrollOverlay({
      brollSrc: "https://assets.aksharo.com/stock/rocket.mp4",
      mainVideoSrc: "https://assets.aksharo.com/projects/main.mp4",
      startSec: 4.0,
      endSec: 8.0,
      currentTimeSec: 6.0,
      fps: 30,
      motion: "push-in",
      mode: "full",
      subtitleChildren: ["Spoken caption text"],
    });

    // Root container
    expect(vnode.props["data-testid"]).toBe("broll-overlay-root");

    // Layer 1: Main Video
    const mainVideoNode = findVNodeByTestId(vnode, "broll-main-video");
    expect(mainVideoNode).toBeDefined();
    expect(mainVideoNode?.props.src).toBe("https://assets.aksharo.com/projects/main.mp4");
    expect(mainVideoNode?.props.style?.zIndex).toBe(1);

    // Layer 2: Sequence & B-Roll Video
    const sequenceNode = findVNodeByTestId(vnode, "broll-sequence");
    expect(sequenceNode).toBeDefined();
    expect(sequenceNode?.type).toBe("Sequence");
    expect(sequenceNode?.props.from).toBe(120); // 4.0s * 30fps
    expect(sequenceNode?.props.durationInFrames).toBe(120); // (8.0s - 4.0s) * 30fps

    const brollVideoNode = findVNodeByTestId(vnode, "broll-stock-video");
    expect(brollVideoNode).toBeDefined();
    expect(brollVideoNode?.props.src).toBe("https://assets.aksharo.com/stock/rocket.mp4");
    // CRITICAL: Audio must be strictly muted
    expect(brollVideoNode?.props.muted).toBe(true);
    expect(brollVideoNode?.props.volume).toBe(0);
    expect(brollVideoNode?.props.style?.zIndex).toBe(10);

    // Layer 3: Subtitles / Emojis on TOP (zIndex 50)
    const subtitleLayerNode = findVNodeByTestId(vnode, "broll-subtitles-layer");
    expect(subtitleLayerNode).toBeDefined();
    expect(subtitleLayerNode?.props.style?.zIndex).toBe(50);
    expect(subtitleLayerNode?.props.children).toContain("Spoken caption text");
  });

  describe("computeBrollKenBurnsTransform", () => {
    it("interpolates scale smoothly from 1.0 to 1.08 for push-in motion", () => {
      const atStart = computeBrollKenBurnsTransform(0.0, "push-in", 0.08);
      expect(atStart.scale).toBe(1.0);
      expect(atStart.transformString).toBe("scale(1)");

      const atMid = computeBrollKenBurnsTransform(0.5, "push-in", 0.08);
      expect(atMid.scale).toBe(1.04);
      expect(atMid.transformString).toBe("scale(1.04)");

      const atEnd = computeBrollKenBurnsTransform(1.0, "push-in", 0.08);
      expect(atEnd.scale).toBe(1.08);
      expect(atEnd.transformString).toBe("scale(1.08)");
    });

    it("interpolates scale down from 1.08 to 1.0 for pull-out motion", () => {
      const atStart = computeBrollKenBurnsTransform(0.0, "pull-out", 0.08);
      expect(atStart.scale).toBe(1.08);

      const atEnd = computeBrollKenBurnsTransform(1.0, "pull-out", 0.08);
      expect(atEnd.scale).toBe(1.0);
    });

    it("applies horizontal translation for pan motions", () => {
      const panLeft = computeBrollKenBurnsTransform(0.5, "pan-left", 0.08);
      expect(panLeft.scale).toBe(1.08);
      expect(panLeft.translateX).toBe(0);

      const panLeftStart = computeBrollKenBurnsTransform(0.0, "pan-left", 0.08);
      expect(panLeftStart.translateX).toBe(20);
    });
  });

  describe("computeBrollDissolveOpacity", () => {
    it("fades in over 100ms, stays opaque, and fades out over 100ms", () => {
      const startSec = 5.0;
      const endSec = 9.0;
      const dissolveSec = 0.1; // 100ms

      // Before start: 0.0
      expect(computeBrollDissolveOpacity(4.9, startSec, endSec, dissolveSec)).toBe(0.0);

      // Mid-ramp-in (50ms in): 0.5
      expect(computeBrollDissolveOpacity(5.05, startSec, endSec, dissolveSec)).toBe(0.5);

      // Fully faded in (150ms in): 1.0
      expect(computeBrollDissolveOpacity(5.15, startSec, endSec, dissolveSec)).toBe(1.0);

      // Mid-clip (7.0s): 1.0
      expect(computeBrollDissolveOpacity(7.0, startSec, endSec, dissolveSec)).toBe(1.0);

      // Mid-ramp-out (50ms before end): 0.5
      expect(computeBrollDissolveOpacity(8.95, startSec, endSec, dissolveSec)).toBe(0.5);

      // After end: 0.0
      expect(computeBrollDissolveOpacity(9.1, startSec, endSec, dissolveSec)).toBe(0.0);
    });
  });

  describe("buildBrollFfmpegFiltergraph", () => {
    it("generates valid FFmpeg filter chain with zoompan and fades", () => {
      const filter = buildBrollFfmpegFiltergraph({
        mainInputIndex: 0,
        brollInputIndex: 1,
        startSec: 3.5,
        endSec: 7.0,
        dissolveSec: 0.1,
      });

      expect(filter).toContain("[1:v]scale=1080:1920");
      expect(filter).toContain("zoompan=");
      expect(filter).toContain("fade=t=in:st=0:d=0.1:alpha=1");
      expect(filter).toContain("fade=t=out:st=3.4:d=0.1:alpha=1");
      expect(filter).toContain("overlay=0:0:enable='between(t,3.5,7)'");
    });
  });
});

