/** @jsx h */
/**
 * Pillar 3 §04 — Screen Share & Presentation Slide Detection Engine
 * Unit & Visual Tests (`CanvasFitLayout.test.tsx`)
 *
 * Verifies:
 * 1. `<CanvasFitLayout />` / `<SmartCanvasFit />` VNode tree structure:
 *    - Background `<OffthreadVideo style={{ filter: 'blur(30px) brightness(0.6)', transform: 'scale(1.4)' }} />`
 *    - Foreground `<OffthreadVideo style={{ width: '1080px', height: '608px', objectFit: 'contain' }} />`
 *      centered vertically at `y = 656` (`(1920 - 608) / 2`) or placed at `y = 360` (`presentation-fit`).
 *    - Optional `280px` circular presenter PIP bubble (`borderRadius: '50%'`) at `top-right` or `bottom-center`.
 * 2. Visual pixel-level verification (`compositeCanvasFitRgbaFrame`) confirming ZERO cropped text
 *    across the full horizontal span (`x = 0..1919` -> `x = 0..1079`) of 16:9 presentation fixtures
 *    rendered in a 9:16 (`1080 x 1920`) vertical canvas.
 * 3. FFmpeg filtergraph synthesis (`buildCanvasFitFfmpegFilter`).
 */

import { describe, expect, it } from "vitest";

import {
  CANVAS_FIT_HEIGHT,
  CANVAS_FIT_WIDTH,
  CanvasFitLayout,
  PIP_BUBBLE_DIAMETER,
  SLIDE_CENTER_Y,
  SLIDE_FIT_HEIGHT,
  SLIDE_FIT_WIDTH,
  SLIDE_PRESENTATION_FIT_Y,
  SmartCanvasFit,
  buildCanvasFitFfmpegFilter,
  compositeCanvasFitRgbaFrame,
  computePipBubbleGeometry,
  computeSlideGeometry,
} from "./CanvasFitLayout.js";
import { h, type SplitScreenVNode } from "./SplitScreenView.js";

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

describe("CanvasFitLayout / SmartCanvasFit (Pillar 3 §04 Screen Share & Presentation Slide Detection Engine)", () => {
  it("computes un-cropped 1080x608 slide geometry centered at y=656 or placed at y=360", () => {
    const centered = computeSlideGeometry(1920, 1080);
    expect(centered).toEqual({
      width: SLIDE_FIT_WIDTH, // 1080
      height: SLIDE_FIT_HEIGHT, // 608
      x: 0,
      y: SLIDE_CENTER_Y, // (1920 - 608) / 2 = 656
    });

    const presentationFit = computeSlideGeometry(1920, 1080, {
      placement: "presentation-fit",
    });
    expect(presentationFit).toEqual({
      width: 1080,
      height: 608,
      x: 0,
      y: SLIDE_PRESENTATION_FIT_Y, // 360
    });
  });

  it("renders background blur(30px) brightness(0.6) scale(1.4) and foreground 1080x608 contain layers", () => {
    const tree = (
      <SmartCanvasFit
        src="https://cdn.example.com/q3-roadmap-slide.mp4"
        sourceWidth={1920}
        sourceHeight={1080}
        layoutMode="CANVAS_FIT"
      />
    );

    const root = findByTestId(tree, "canvas-fit-layout");
    expect(root).not.toBeNull();
    expect(root?.props["data-layout-mode"]).toBe("CANVAS_FIT");

    const bg = findByTestId(tree, "canvas-fit-background");
    expect(bg).not.toBeNull();
    const bgVideo = bg?.props.children[0] as SplitScreenVNode | undefined;
    expect(bgVideo?.props.style?.["filter"]).toBe("blur(30px) brightness(0.6)");
    expect(bgVideo?.props.style?.["transform"]).toBe("scale(1.4)");

    const fg = findByTestId(tree, "canvas-fit-foreground");
    expect(fg).not.toBeNull();
    expect(fg?.props["data-slide-width"]).toBe(1080);
    expect(fg?.props["data-slide-height"]).toBe(608);
    expect(fg?.props["data-slide-y"]).toBe(656);

    const fgVideo = fg?.props.children[0] as SplitScreenVNode | undefined;
    expect(fgVideo?.props.style?.["width"]).toBe("1080px");
    expect(fgVideo?.props.style?.["height"]).toBe("608px");
    expect(fgVideo?.props.style?.["objectFit"]).toBe("contain");

    // No PIP bubble in pure CANVAS_FIT mode
    expect(findByTestId(tree, "canvas-fit-pip-bubble")).toBeNull();
  });

  it("renders a 280px circular presenter PIP bubble in PIP_BUBBLE mode", () => {
    const tree = CanvasFitLayout({
      src: "https://cdn.example.com/vscode-demo-pip.mp4",
      sourceWidth: 1920,
      sourceHeight: 1080,
      layoutMode: "PIP_BUBBLE",
      placement: "presentation-fit",
      presenterPip: {
        cropRect: { x: 1560, y: 780, width: 280, height: 240 },
        position: "bottom-center",
      },
    });

    const fg = findByTestId(tree, "canvas-fit-foreground");
    expect(fg?.props["data-slide-y"]).toBe(360);

    const pip = findByTestId(tree, "canvas-fit-pip-bubble");
    expect(pip).not.toBeNull();
    expect(pip?.props["data-pip-position"]).toBe("bottom-center");
    expect(pip?.props["data-pip-diameter"]).toBe(PIP_BUBBLE_DIAMETER);
    expect(pip?.props.style?.borderRadius).toBe("50%");
    expect(pip?.props.style?.width).toBe("280px");
    expect(pip?.props.style?.height).toBe("280px");
  });

  it("verifies zero cropped text on a 16:9 presentation fixture rendered into a 9:16 RGBA frame", () => {
    // Use a scaled-down proportional 16:9 -> 9:16 fixture (192x108 -> 108x192) for fast pixel-exact verification
    const sourceWidth = 192;
    const sourceHeight = 108;
    const canvasWidth = 108;
    const canvasHeight = 192;
    const sourceRgba = new Uint8Array(sourceWidth * sourceHeight * 4);

    // Fill slide canvas with dark navy background (R=20, G=30, B=50)
    for (let i = 0; i < sourceWidth * sourceHeight; i += 1) {
      sourceRgba[i * 4] = 20;
      sourceRgba[i * 4 + 1] = 30;
      sourceRgba[i * 4 + 2] = 50;
      sourceRgba[i * 4 + 3] = 255;
    }

    // Place bright cyan "left margin text" at extreme left edge (x = 1..4, y = 50..58)
    // and bright magenta "right margin text" at extreme right edge (x = 187..190, y = 50..58).
    // A naive 9:16 center crop would discard x < 62 and x > 130, destroying both text regions!
    for (let y = 48; y < 60; y += 1) {
      for (let x = 1; x <= 4; x += 1) {
        const idx = (y * sourceWidth + x) * 4;
        sourceRgba[idx] = 0;
        sourceRgba[idx + 1] = 250;
        sourceRgba[idx + 2] = 255;
      }
      for (let x = sourceWidth - 5; x <= sourceWidth - 2; x += 1) {
        const idx = (y * sourceWidth + x) * 4;
        sourceRgba[idx] = 255;
        sourceRgba[idx + 1] = 20;
        sourceRgba[idx + 2] = 220;
      }
    }

    // Place green presenter webcam marker in bottom-right corner (x = 160..188, y = 80..104)
    for (let y = 80; y < 104; y += 1) {
      for (let x = 160; x < 188; x += 1) {
        const idx = (y * sourceWidth + x) * 4;
        sourceRgba[idx] = 30;
        sourceRgba[idx + 1] = 230;
        sourceRgba[idx + 2] = 90;
      }
    }

    const out = compositeCanvasFitRgbaFrame({
      sourceRgba,
      sourceWidth,
      sourceHeight,
      canvasWidth,
      canvasHeight,
      layoutMode: "PIP_BUBBLE",
      presenterPip: {
        cropRect: { x: 160, y: 80, width: 28, height: 24 },
        position: "bottom-center",
        diameter: 64,
      },
    });

    const slide = computeSlideGeometry(sourceWidth, sourceHeight, { canvasWidth, canvasHeight });
    expect(slide.width).toBe(108);
    expect(slide.height).toBe(60);
    expect(slide.y).toBe(66);

    const midSlideY = slide.y + Math.floor(slide.height / 2);

    // Verify far-left text (x = 1) is preserved inside the 9:16 output frame
    const leftPixelIdx = (midSlideY * canvasWidth + 1) * 4;
    expect(out[leftPixelIdx]).toBe(0);
    expect(out[leftPixelIdx + 1]).toBe(250);
    expect(out[leftPixelIdx + 2]).toBe(255);

    // Verify far-right text (x = canvasWidth - 2) is preserved inside the 9:16 output frame
    const rightPixelIdx = (midSlideY * canvasWidth + (canvasWidth - 2)) * 4;
    expect(out[rightPixelIdx]).toBe(255);
    expect(out[rightPixelIdx + 1]).toBe(20);
    expect(out[rightPixelIdx + 2]).toBe(220);

    // Verify top ambient background (y = 10, x = 54) is darkened to 60% of navy (12, 18, 30)
    const bgTopIdx = (10 * canvasWidth + 54) * 4;
    expect(out[bgTopIdx]).toBe(12);
    expect(out[bgTopIdx + 1]).toBe(18);
    expect(out[bgTopIdx + 2]).toBe(30);

    // Verify circular PIP bubble center contains the green presenter webcam feed
    const pip = computePipBubbleGeometry(
      sourceWidth,
      sourceHeight,
      slide,
      { cropRect: { x: 160, y: 80, width: 28, height: 24 }, position: "bottom-center", diameter: 64 },
      canvasWidth,
      canvasHeight,
    );
    const pipCenterX = pip.x + Math.floor(pip.diameter / 2);
    const pipCenterY = pip.y + Math.floor(pip.diameter / 2);
    const pipCenterIdx = (pipCenterY * canvasWidth + pipCenterX) * 4;
    expect(out[pipCenterIdx]).toBe(30);
    expect(out[pipCenterIdx + 1]).toBe(230);
    expect(out[pipCenterIdx + 2]).toBe(90);
  });

  it("builds valid FFmpeg filtergraphs for CANVAS_FIT and PIP_BUBBLE modes", () => {
    const fitGraph = buildCanvasFitFfmpegFilter({
      src: "slide.mp4",
      sourceWidth: 1920,
      sourceHeight: 1080,
      layoutMode: "CANVAS_FIT",
    });
    expect(fitGraph).toContain("split=2[bg_in][fg_in]");
    expect(fitGraph).toContain("gblur=sigma=30,eq=brightness=-0.12[bg]");
    expect(fitGraph).toContain("scale=1080:608:flags=bicubic,setsar=1[fg]");
    expect(fitGraph).toContain("overlay=(W-w)/2:656");

    const pipGraph = buildCanvasFitFfmpegFilter({
      src: "slide.mp4",
      sourceWidth: 1920,
      sourceHeight: 1080,
      layoutMode: "PIP_BUBBLE",
      placement: "presentation-fit",
      presenterPip: {
        cropRect: { x: 1560, y: 780, width: 280, height: 240 },
        position: "top-right",
      },
    });
    expect(pipGraph).toContain("split=3[bg_in][fg_in][pip_in]");
    expect(pipGraph).toContain("overlay=(W-w)/2:360[base]");
    expect(pipGraph).toContain("scale=280:280:flags=bicubic");
  });
});
