/* eslint-disable security/detect-object-injection */
/** @jsx h */
import { describe, expect, it } from "vitest";

import {
  OffthreadVideo,
  SplitScreenLayout,
  SplitScreenView,
  buildSplitScreenFfmpegFilter,
  compositeSplitScreenRgbaFrame,
  computePaneVideoLayout,
  findVNodeByTestId,
  findVNodesByType,
  h,
  type SplitScreenConfig,
} from "./SplitScreenView.js";

const SAMPLE_CONFIG: SplitScreenConfig = {
  enabled: true,
  topCrop: { x: 80, y: 180, width: 640, height: 720 },
  bottomCrop: { x: 1200, y: 180, width: 640, height: 720 },
  dividerColor: "#1A1A1A",
  activeSpeakerHighlight: true,
};

describe("SplitScreenView Remotion Component & 1080x1920 Canvas Render (Pillar 3 §02)", () => {
  it("renders two <OffthreadVideo> elements referencing the same source video in locked Top and Bottom panes", () => {
    expect(typeof h).toBe("function");
    const tree = (
      <SplitScreenView
        src="https://cdn.aksharo.test/podcast-16x9.mp4"
        sourceWidth={1920}
        sourceHeight={1080}
        config={SAMPLE_CONFIG}
        activeSpeaker="top"
        captionPlacement="divider"
        captionWords={[
          { text: "That", startSec: 0.0, endSec: 0.3 },
          { text: "reaction", startSec: 0.3, endSec: 0.8 },
          { text: "was", startSec: 0.8, endSec: 1.1 },
          { text: "priceless!", startSec: 1.1, endSec: 1.6 },
        ]}
        currentTimeSec={0.5}
      />
    );

    expect(SplitScreenLayout).toBe(SplitScreenView);
    expect(OffthreadVideo).toBeDefined();

    // Verify 1080x1920 root canvas
    expect(tree.props["data-testid"]).toBe("split-screen-canvas");
    expect(tree.props.style?.width).toBe(1080);
    expect(tree.props.style?.height).toBe(1920);

    // Verify two <OffthreadVideo> elements referencing the identical source video
    const videos = findVNodesByType(tree, "OffthreadVideo");
    expect(videos).toHaveLength(2);
    expect(videos[0]?.props["src"]).toBe("https://cdn.aksharo.test/podcast-16x9.mp4");
    expect(videos[1]?.props["src"]).toBe("https://cdn.aksharo.test/podcast-16x9.mp4");
    expect(videos[0]?.props["data-pane"]).toBe("top");
    expect(videos[1]?.props["data-pane"]).toBe("bottom");

    // Verify Top and Bottom panes use absolute positioning and CSS clip-path locking
    const topPane = findVNodeByTestId(tree, "split-screen-top-pane");
    const bottomPane = findVNodeByTestId(tree, "split-screen-bottom-pane");
    expect(topPane?.props.style?.position).toBe("absolute");
    expect(topPane?.props.style?.top).toBe(0);
    expect(topPane?.props.style?.width).toBe(1080);
    expect(topPane?.props.style?.height).toBe(960);
    expect(topPane?.props.style?.clipPath).toBe("inset(0px 0px 0px 0px)");

    expect(bottomPane?.props.style?.position).toBe("absolute");
    expect(bottomPane?.props.style?.top).toBe(960);
    expect(bottomPane?.props.style?.width).toBe(1080);
    expect(bottomPane?.props.style?.height).toBe(960);
    expect(bottomPane?.props.style?.clipPath).toBe("inset(0px 0px 0px 0px)");

    // Active speaker highlight scales the talking speaker (top) by 1.02x and adds halo
    expect(topPane?.props["data-active-speaker"]).toBe("true");
    expect(String(topPane?.props.style?.boxShadow)).toContain("rgba(56, 189, 248");
    expect(bottomPane?.props["data-active-speaker"]).toBe("false");

    // Verify 2px middle divider line
    const divider = findVNodeByTestId(tree, "split-screen-divider");
    expect(divider?.props.style?.top).toBe(959);
    expect(divider?.props.style?.height).toBe(2);
    expect(divider?.props.style?.width).toBe(1080);
    expect(divider?.props.style?.backgroundColor).toBe("#1A1A1A");

    // Verify animated kinetic captions centered across the divider line (y = 960)
    const captions = findVNodeByTestId(tree, "kinetic-captions");
    expect(captions?.props["data-placement"]).toBe("divider");
    expect(captions?.props.style?.top).toBe(960);
  });

  it("supports lower-third kinetic caption placement and SOLO_FULL_SCREEN monologue mode", () => {
    const soloTree = (
      <SplitScreenView
        src="https://cdn.aksharo.test/podcast-16x9.mp4"
        config={SAMPLE_CONFIG}
        mode="SOLO_FULL_SCREEN"
        activeSpeaker="bottom"
        captionPlacement="lower-third"
        captionText="Extended monologue insight"
      />
    );

    const topPane = findVNodeByTestId(soloTree, "split-screen-top-pane");
    const bottomPane = findVNodeByTestId(soloTree, "split-screen-bottom-pane");
    const divider = findVNodeByTestId(soloTree, "split-screen-divider");
    const captions = findVNodeByTestId(soloTree, "kinetic-captions");

    expect(topPane?.props.style?.display).toBe("none");
    expect(bottomPane?.props.style?.display).toBe("block");
    expect(bottomPane?.props.style?.height).toBe(1920);
    expect(divider).toBeUndefined();
    expect(captions?.props["data-placement"]).toBe("lower-third");
    expect(captions?.props.style?.top).toBe(1536);
  });

  it("verifies 1080x1920 canvas output contains both speakers without aspect distortion", () => {
    const srcW = 1920;
    const srcH = 1080;
    const sourceRgba = new Uint8Array(srcW * srcH * 4);

    // Fill background with dark charcoal (20, 20, 20, 255)
    for (let i = 0; i < srcW * srcH; i += 1) {
      const idx = i * 4;
      sourceRgba[idx] = 20;
      sourceRgba[idx + 1] = 20;
      sourceRgba[idx + 2] = 20;
      sourceRgba[idx + 3] = 255;
    }

    // Draw a 100x100 square marker for Host (Speaker 1) centered at (400, 540) in red (240, 40, 40)
    // and a 100x100 square marker for Guest (Speaker 2) centered at (1520, 540) in cyan (30, 200, 240)
    const fillRect = (
      x0: number,
      y0: number,
      w: number,
      h: number,
      r: number,
      g: number,
      b: number,
    ): void => {
      for (let y = y0; y < y0 + h; y += 1) {
        for (let x = x0; x < x0 + w; x += 1) {
          const idx = (y * srcW + x) * 4;
          sourceRgba[idx] = r;
          sourceRgba[idx + 1] = g;
          sourceRgba[idx + 2] = b;
          sourceRgba[idx + 3] = 255;
        }
      }
    };

    fillRect(350, 490, 100, 100, 240, 40, 40);
    fillRect(1470, 490, 100, 100, 30, 200, 240);

    const rendered = compositeSplitScreenRgbaFrame(sourceRgba, srcW, srcH, SAMPLE_CONFIG);
    expect(rendered.width).toBe(1080);
    expect(rendered.height).toBe(1920);
    expect(rendered.topGeometry.aspectRatioPreserved).toBe(true);
    expect(rendered.bottomGeometry.aspectRatioPreserved).toBe(true);

    // Verify Top Pane center (x=540, y=480) contains Host (red marker)
    const topCenterIdx = (480 * 1080 + 540) * 4;
    expect(rendered.data[topCenterIdx]).toBe(240);
    expect(rendered.data[topCenterIdx + 1]).toBe(40);
    expect(rendered.data[topCenterIdx + 2]).toBe(40);

    // Verify Bottom Pane center (x=540, y=960 + 480 = 1440) contains Guest (cyan marker)
    const bottomCenterIdx = (1440 * 1080 + 540) * 4;
    expect(rendered.data[bottomCenterIdx]).toBe(30);
    expect(rendered.data[bottomCenterIdx + 1]).toBe(200);
    expect(rendered.data[bottomCenterIdx + 2]).toBe(240);

    // Verify 2px divider at y=959..960 is #1A1A1A (26, 26, 26)
    const dividerIdx = (959 * 1080 + 540) * 4;
    expect(rendered.data[dividerIdx]).toBe(26);
    expect(rendered.data[dividerIdx + 1]).toBe(26);
    expect(rendered.data[dividerIdx + 2]).toBe(26);

    // Verify zero aspect distortion: the 100x100 square marker for Host in the Top pane
    // has equal rendered width and height (1:1 aspect ratio preserved)
    let minRedX = 1080;
    let maxRedX = 0;
    let minRedY = 958;
    let maxRedY = 0;
    for (let y = 0; y < 958; y += 1) {
      for (let x = 0; x < 1080; x += 1) {
        const idx = (y * 1080 + x) * 4;
        if (rendered.data[idx] === 240 && rendered.data[idx + 1] === 40) {
          if (x < minRedX) minRedX = x;
          if (x > maxRedX) maxRedX = x;
          if (y < minRedY) minRedY = y;
          if (y > maxRedY) maxRedY = y;
        }
      }
    }
    const renderedSquareW = maxRedX - minRedX + 1;
    const renderedSquareH = maxRedY - minRedY + 1;
    expect(renderedSquareW).toBeGreaterThan(150);
    expect(Math.abs(renderedSquareW - renderedSquareH)).toBeLessThanOrEqual(2);
  });

  it("builds the FFmpeg dual-stack filtergraph with vstack and 2px drawbox divider", () => {
    const filter = buildSplitScreenFfmpegFilter({
      ...SAMPLE_CONFIG,
      dividerColor: "black@0.6",
    });
    expect(filter).toBe(
      [
        "[0:v]crop=w=640:h=720:x=80:y=180,scale=1080:960[top]",
        "[0:v]crop=w=640:h=720:x=1200:y=180,scale=1080:960[bottom]",
        "[top][bottom]vstack[stacked]",
        "[stacked]drawbox=y=959:color=black@0.6:width=1080:height=2:t=fill[v]",
      ].join(";"),
    );

    const geom = computePaneVideoLayout(
      SAMPLE_CONFIG.topCrop,
      { width: 1920, height: 1080 },
      { width: 1080, height: 960, top: 0 },
      { isActiveSpeaker: true, activeSpeakerHighlight: true },
    );
    expect(geom.activeScale).toBe(1.02);
    expect(geom.aspectRatioPreserved).toBe(true);
  });
});

