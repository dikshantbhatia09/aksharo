/** @jsx h */
/**
 * Pillar 3 §07: Streamer Gameplay & Facecam Split Remotion Engine
 * Unit Tests (`StreamerLayout.test.tsx`)
 *
 * Verifies:
 * 1. `<StreamerLayout />` VNode tree structure:
 *    - Top 35% pane (1080 x 672) with facecam `<OffthreadVideo />`
 *    - Bottom 65% pane (1080 x 1248) with centered action gameplay `<OffthreadVideo />`
 *    - 3px neon gamer divider with glow effect (default `#8B5CF6` Twitch purple)
 *    - Kill-streak alert badge overlay
 *    - Kinetic captions layer across boundary
 * 2. Pure deterministic RGBA buffer compositor `compositeStreamerLayoutRgbaFrame`
 * 3. FFmpeg filtergraph synthesis `buildStreamerLayoutFfmpegFilter`
 */

import { describe, expect, it } from "vitest";

import { h, type SplitScreenVNode } from "./SplitScreenView.js";
import {
  STREAMER_CANVAS_HEIGHT,
  STREAMER_CANVAS_WIDTH,
  STREAMER_DEFAULT_DIVIDER_COLOR,
  STREAMER_NEON_GREEN,
  STREAMER_TOP_PANE_HEIGHT,
  StreamerGameplayLayout,
  StreamerLayout,
  buildStreamerLayoutFfmpegFilter,
  compositeStreamerLayoutRgbaFrame,
  type StreamerLayoutConfig,
} from "./StreamerLayout.js";

function findByTestId(node: SplitScreenVNode, testId: string): SplitScreenVNode | null {
  if (node.props["data-testid"] === testId) {
    return node;
  }
  for (const child of node.props.children) {
    if (typeof child === "string") continue;
    const found = findByTestId(child, testId);
    if (found !== null) return found;
  }
  return null;
}

const mockConfig: StreamerLayoutConfig = {
  facecamCrop: { x: 1400, y: 700, width: 480, height: 360 },
  gameplayCrop: { x: 492, y: 0, width: 934, height: 1080 },
  dividerColor: STREAMER_DEFAULT_DIVIDER_COLOR,
  showNeonGlow: true,
};

describe("StreamerLayout (Pillar 3 §07 Streamer Gameplay & Facecam Split Engine)", () => {
  it("renders 1080x1920 canvas with Top 35% facecam and Bottom 65% gameplay panes", () => {
    const tree = (
      <StreamerLayout
        src="https://cdn.example.com/twitch-vod-clip.mp4"
        sourceWidth={1920}
        sourceHeight={1080}
        config={mockConfig}
      />
    );

    const canvas = findByTestId(tree, "streamer-layout-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.props.style?.["width"]).toBe(STREAMER_CANVAS_WIDTH);
    expect(canvas?.props.style?.["height"]).toBe(STREAMER_CANVAS_HEIGHT);

    // Top 35% facecam pane (height 672)
    const topPane = findByTestId(tree, "streamer-top-pane");
    expect(topPane).not.toBeNull();
    expect(topPane?.props.style?.["height"]).toBe(STREAMER_TOP_PANE_HEIGHT);
    expect(topPane?.props.style?.["width"]).toBe(STREAMER_CANVAS_WIDTH);

    const facecamVideo = findByTestId(tree, "offthread-video-facecam");
    expect(facecamVideo).not.toBeNull();
    expect(facecamVideo?.props["src"]).toBe("https://cdn.example.com/twitch-vod-clip.mp4");

    // Bottom 65% gameplay pane (height 1248)
    const bottomPane = findByTestId(tree, "streamer-bottom-pane");
    expect(bottomPane).not.toBeNull();
    expect(bottomPane?.props.style?.["height"]).toBe(1248);
    expect(bottomPane?.props.style?.["top"]).toBe(STREAMER_TOP_PANE_HEIGHT);

    const gameplayVideo = findByTestId(tree, "offthread-video-gameplay");
    expect(gameplayVideo).not.toBeNull();
  });

  it("renders 3px neon gamer divider with glow effect and customizable colors", () => {
    const greenConfig: StreamerLayoutConfig = {
      ...mockConfig,
      dividerColor: STREAMER_NEON_GREEN,
      dividerThickness: 3,
      showNeonGlow: true,
    };

    const tree = (
      <StreamerGameplayLayout
        src="https://cdn.example.com/stream.mp4"
        config={greenConfig}
      />
    );

    const divider = findByTestId(tree, "streamer-divider");
    expect(divider).not.toBeNull();
    expect(divider?.props.style?.["height"]).toBe(3);
    expect(divider?.props.style?.["backgroundColor"]).toBe(STREAMER_NEON_GREEN);
    expect(divider?.props.style?.["boxShadow"]).toContain(STREAMER_NEON_GREEN);
  });

  it("renders gamer clutch / kill-streak alert badge when configured", () => {
    const clutchConfig: StreamerLayoutConfig = {
      ...mockConfig,
      killStreakAlert: {
        text: "PENTAKILL CLUTCH",
        active: true,
        badgeColor: "#EF4444",
      },
    };

    const tree = (
      <StreamerLayout
        src="https://cdn.example.com/stream.mp4"
        config={clutchConfig}
      />
    );

    const badge = findByTestId(tree, "gamer-alert-badge");
    expect(badge).not.toBeNull();
    expect(badge?.props.style?.["backgroundColor"]).toBe("#EF4444");
    expect(badge?.props.children).toContain("PENTAKILL CLUTCH");
  });

  it("renders kinetic captions across the split boundary", () => {
    const words = [
      { text: "LETS", startSec: 0.0, endSec: 0.5 },
      { text: "GOOO", startSec: 0.5, endSec: 1.2, highlightColor: "#00FFA3" },
    ];

    const tree = (
      <StreamerLayout
        src="https://cdn.example.com/stream.mp4"
        config={mockConfig}
        captionWords={words}
        currentTimeSec={0.8}
      />
    );

    const captions = findByTestId(tree, "streamer-captions");
    expect(captions).not.toBeNull();
    expect(captions?.props["data-placement"]).toBe("boundary");
    expect(captions?.props.style?.["top"]).toBe(STREAMER_TOP_PANE_HEIGHT);
  });

  it("builds valid FFmpeg filtergraph with dual crops, vstack and 3px neon drawbox", () => {
    const filter = buildStreamerLayoutFfmpegFilter(mockConfig, {
      canvasWidth: 1080,
      canvasHeight: 1920,
    });

    expect(filter).toContain("crop=w=480:h=360:x=1400:y=700,scale=1080:672[facecam]");
    expect(filter).toContain("crop=w=934:h=1080:x=492:y=0,scale=1080:1248[gameplay]");
    expect(filter).toContain("[facecam][gameplay]vstack[stacked]");
    expect(filter).toContain("drawbox=y=671:color=#8B5CF6:width=1080:height=3:t=fill[v]");
  });

  it("composites pure RGBA frame buffer without aspect distortion and draws neon separator", () => {
    const srcW = 1920;
    const srcH = 1080;
    const srcRgba = new Uint8Array(srcW * srcH * 4);

    // Fill source with uniform blue
    for (let i = 0; i < srcW * srcH; i += 1) {
      srcRgba[i * 4] = 30;
      srcRgba[i * 4 + 1] = 60;
      srcRgba[i * 4 + 2] = 200;
      srcRgba[i * 4 + 3] = 255;
    }

    const res = compositeStreamerLayoutRgbaFrame(srcRgba, srcW, srcH, mockConfig);
    expect(res.width).toBe(1080);
    expect(res.height).toBe(1920);
    expect(res.data.length).toBe(1080 * 1920 * 4);
    expect(res.topGeometry.aspectRatioPreserved).toBe(true);
    expect(res.bottomGeometry.aspectRatioPreserved).toBe(true);

    // Verify 3px neon divider line at y = 671
    const divY = 671;
    const divIdx = (divY * 1080 + 540) * 4;
    // #8B5CF6 -> r=139, g=92, b=246
    expect(res.data[divIdx]).toBe(139);
    expect(res.data[divIdx + 1]).toBe(92);
    expect(res.data[divIdx + 2]).toBe(246);
  });
});
