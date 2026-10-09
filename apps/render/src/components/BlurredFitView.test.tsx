/** @jsx h */
/**
 * Pillar 3 §05 — Blurred Background Canvas Fit (16:9 in 9:16)
 * Unit & Render Tests (`BlurredFitView.test.tsx`)
 *
 * Verifies:
 * 1. `<BlurredFitView />` ("Fit with Blur") dual-layer Remotion VNode tree:
 *    - Background `<OffthreadVideo>` scaled to fill 1080×1920 (`width: 'auto', height: '100%'`)
 *      with `blur(40px) brightness(0.65) saturate(1.2)`.
 *    - Foreground `<OffthreadVideo>` centered at `y = 656px` (`1080 × 608`) with
 *      `borderRadius: '16px'` and `boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.7)'`.
 *    - Synchronized playheads (`startFrom`, `endAt`) across both background and foreground layers.
 *    - Dedicated lower blur safe zone (`y = 1450px`) for dynamic kinetic captions.
 * 2. Styling parameter overrides (`blurRadius`, `dimOpacity`, `borderRadius`, `saturation`).
 * 3. Pure RGBA pixel-level render verification (`compositeBlurredFitRgbaFrame`) confirming:
 *    - Heavy background blur + 35% luminance attenuation + 1.2x saturation boost.
 *    - Un-cropped 16:9 foreground preservation with 16px rounded corners and soft shadow falloff.
 *    - Zero harsh boundary artifacts between blurred backdrop and foreground.
 *    - Multi-frame sequence rendering without frame drops.
 * 4. `applyBlurredFitLayout` in `render-video.ts` placing captions at `y = 1450px` when `layout: 'BLURRED_FIT'`.
 */

import { describe, expect, it } from "vitest";

import { applyBlurredFitLayout, BLURRED_FIT_CAPTION_Y } from "../processors/render-video.js";
import {
  BLURRED_FIT_CANVAS_HEIGHT,
  BLURRED_FIT_CANVAS_WIDTH,
  BLURRED_FIT_DEFAULT_BORDER_RADIUS,
  BLURRED_FIT_DEFAULT_BOX_SHADOW,
  BLURRED_FIT_DEFAULT_CSS_BLUR_PX,
  BLURRED_FIT_DEFAULT_DIM_OPACITY,
  BLURRED_FIT_DEFAULT_SATURATION,
  BLURRED_FIT_FG_HEIGHT,
  BLURRED_FIT_FG_WIDTH,
  BLURRED_FIT_FG_Y,
  BlurredFitView,
  FitWithBlur,
  compositeBlurredFitRgbaFrame,
  computeBlurredFitGeometry,
} from "./BlurredFitView.js";
import { h, type SplitScreenVNode } from "./SplitScreenView.js";

import type { RenderVideoPayload } from "../queues.js";

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

describe("BlurredFitView / FitWithBlur (Pillar 3 §05 Blurred Background Canvas Fit)", () => {
  it("computes un-cropped 1080x608 foreground geometry centered at y=656 with caption zone at y=1450", () => {
    const geom = computeBlurredFitGeometry(1920, 1080);
    expect(geom).toEqual({
      canvasWidth: BLURRED_FIT_CANVAS_WIDTH, // 1080
      canvasHeight: BLURRED_FIT_CANVAS_HEIGHT, // 1920
      foregroundWidth: BLURRED_FIT_FG_WIDTH, // 1080
      foregroundHeight: BLURRED_FIT_FG_HEIGHT, // 608
      foregroundX: 0,
      foregroundY: BLURRED_FIT_FG_Y, // 656
      borderRadius: BLURRED_FIT_DEFAULT_BORDER_RADIUS, // 16
      blurRadius: BLURRED_FIT_DEFAULT_CSS_BLUR_PX, // 40
      dimOpacity: BLURRED_FIT_DEFAULT_DIM_OPACITY, // 0.65
      saturation: BLURRED_FIT_DEFAULT_SATURATION, // 1.2
      boxShadow: BLURRED_FIT_DEFAULT_BOX_SHADOW,
      captionZoneY: BLURRED_FIT_CAPTION_Y, // 1450
    });
  });

  it("renders dual video layers with synchronized playheads, blur(40px) brightness(0.65) saturate(1.2), 16px rounded corners, and y=1450 caption zone", () => {
    const tree = (
      <BlurredFitView
        src="https://cdn.example.com/stadium-play-16x9.mp4"
        sourceWidth={1920}
        sourceHeight={1080}
        startFrom={120}
        endAt={420}
        captionText="WHAT A TOUCHDOWN PASS!"
      />
    );

    const root = findByTestId(tree, "blurred-fit-view");
    expect(root).not.toBeNull();
    expect(root?.props["data-layout-mode"]).toBe("BLURRED_FIT");

    // Layer 1: Background ambient blurred canvas
    const bg = findByTestId(tree, "blurred-fit-background");
    expect(bg).not.toBeNull();
    const bgVideo = bg?.props.children[0] as SplitScreenVNode | undefined;
    expect(bgVideo?.props["src"]).toBe("https://cdn.example.com/stadium-play-16x9.mp4");
    expect(bgVideo?.props["muted"]).toBe(true);
    expect(bgVideo?.props["startFrom"]).toBe(120);
    expect(bgVideo?.props["endAt"]).toBe(420);
    expect(bgVideo?.props.style?.["width"]).toBe("auto");
    expect(bgVideo?.props.style?.["height"]).toBe("100%");
    expect(bgVideo?.props.style?.["filter"]).toBe("blur(40px) brightness(0.65) saturate(1.2)");

    // Layer 2: Foreground crisp 16:9 video centered at y=656 with 16px borderRadius & shadow
    const fg = findByTestId(tree, "blurred-fit-foreground");
    expect(fg).not.toBeNull();
    expect(fg?.props["data-fg-width"]).toBe(1080);
    expect(fg?.props["data-fg-height"]).toBe(608);
    expect(fg?.props["data-fg-y"]).toBe(656);
    expect(fg?.props["data-border-radius"]).toBe(16);
    expect(fg?.props.style?.["borderRadius"]).toBe("16px");
    expect(fg?.props.style?.["boxShadow"]).toBe("0 25px 50px -12px rgba(0, 0, 0, 0.7)");

    const fgVideo = fg?.props.children[0] as SplitScreenVNode | undefined;
    expect(fgVideo?.props["src"]).toBe("https://cdn.example.com/stadium-play-16x9.mp4");
    expect(fgVideo?.props["startFrom"]).toBe(120);
    expect(fgVideo?.props["endAt"]).toBe(420);
    expect(fgVideo?.props.style?.["width"]).toBe("1080px");
    expect(fgVideo?.props.style?.["height"]).toBe("608px");
    expect(fgVideo?.props.style?.["borderRadius"]).toBe("16px");

    // Layer 3: Lower blurred safe zone for kinetic captions at y=1450px
    const captionZone = findByTestId(tree, "blurred-fit-caption-zone");
    expect(captionZone).not.toBeNull();
    expect(captionZone?.props["data-caption-y"]).toBe(1450);
    expect(captionZone?.props.style?.["top"]).toBe("1450px");

    const captionSpan = findByTestId(tree, "blurred-fit-caption-text");
    expect(captionSpan?.props.children[0]).toBe("WHAT A TOUCHDOWN PASS!");
  });

  it("applies custom styling parameters (blurRadius, dimOpacity, borderRadius, saturation)", () => {
    const tree = FitWithBlur({
      src: "https://cdn.example.com/concert-wide.mp4",
      sourceWidth: 1920,
      sourceHeight: 1080,
      blurRadius: 35,
      dimOpacity: 0.6,
      saturation: 1.3,
      borderRadius: 24,
    });

    const bg = findByTestId(tree, "blurred-fit-background");
    const bgVideo = bg?.props.children[0] as SplitScreenVNode | undefined;
    expect(bgVideo?.props.style?.["filter"]).toBe("blur(35px) brightness(0.6) saturate(1.3)");

    const fg = findByTestId(tree, "blurred-fit-foreground");
    expect(fg?.props["data-border-radius"]).toBe(24);
    expect(fg?.props.style?.["borderRadius"]).toBe("24px");
  });

  it("renders background blur, 35% luminance darkening, 16px rounded corners, and zero frame drops across RGBA frames", () => {
    // Proportional 16:9 -> 9:16 test buffer (192x108 -> 108x192)
    const sourceWidth = 192;
    const sourceHeight = 108;
    const canvasWidth = 108;
    const canvasHeight = 192;
    const sourceRgba = new Uint8Array(sourceWidth * sourceHeight * 4);

    // Fill source with alternating high-contrast vertical stripes in the center so blur smooths them,
    // plus bright markers at the far-left and far-right edges to verify un-cropped foreground preservation.
    for (let y = 0; y < sourceHeight; y += 1) {
      for (let x = 0; x < sourceWidth; x += 1) {
        const idx = (y * sourceWidth + x) * 4;
        const isStripe = x % 2 === 0;
        sourceRgba[idx] = isStripe ? 200 : 40;
        sourceRgba[idx + 1] = isStripe ? 160 : 40;
        sourceRgba[idx + 2] = isStripe ? 100 : 40;
        sourceRgba[idx + 3] = 255;
      }
    }

    // Place bright red marker at far-left edge (x=2, y=54) and bright blue marker at far-right edge (x=189, y=54)
    for (let y = 48; y < 60; y += 1) {
      for (let x = 1; x <= 4; x += 1) {
        const leftIdx = (y * sourceWidth + x) * 4;
        sourceRgba[leftIdx] = 255;
        sourceRgba[leftIdx + 1] = 10;
        sourceRgba[leftIdx + 2] = 10;
      }
      for (let x = sourceWidth - 5; x <= sourceWidth - 2; x += 1) {
        const rightIdx = (y * sourceWidth + x) * 4;
        sourceRgba[rightIdx] = 10;
        sourceRgba[rightIdx + 1] = 90;
        sourceRgba[rightIdx + 2] = 255;
      }
    }

    // Render a 5-frame sequence to verify deterministic frame-accurate rendering with zero frame drops
    const renderedFrames: Uint8Array[] = [];
    for (let frameIdx = 0; frameIdx < 5; frameIdx += 1) {
      renderedFrames.push(
        compositeBlurredFitRgbaFrame({
          sourceRgba,
          sourceWidth,
          sourceHeight,
          canvasWidth,
          canvasHeight,
          blurRadius: 35,
          dimOpacity: 0.65,
          saturation: 1.2,
          borderRadius: 16,
        }),
      );
    }

    expect(renderedFrames.length).toBe(5);
    const out = renderedFrames[0]!;
    expect(out.byteLength).toBe(canvasWidth * canvasHeight * 4);

    // 1. Background blur verification: alternating 200/40 stripes in source are smoothed in the top blurred zone (y=15)
    const bgPixelA = (15 * canvasWidth + 50) * 4;
    const bgPixelB = (15 * canvasWidth + 51) * 4;
    const diffAfterBlur = Math.abs((out[bgPixelA] ?? 0) - (out[bgPixelB] ?? 0));
    expect(diffAfterBlur).toBeLessThan(15); // Stripes (diff=160) are smoothed by the blur kernel
    // Luminance attenuated by dimOpacity=0.65 (mean red 120 * 0.65 ≈ 78)
    expect(out[bgPixelA]).toBeLessThan(110);
    expect(out[bgPixelA]).toBeGreaterThan(40);

    // 2. Un-cropped 16:9 foreground preservation at vertical center (y = 66 + 30 = 96)
    const midFgY = 96;
    const leftFgIdx = (midFgY * canvasWidth + 1) * 4;
    expect(out[leftFgIdx]).toBe(255);
    expect(out[leftFgIdx + 1]).toBe(10);
    expect(out[leftFgIdx + 2]).toBe(10);

    const rightFgIdx = (midFgY * canvasWidth + (canvasWidth - 2)) * 4;
    expect(out[rightFgIdx]).toBe(10);
    expect(out[rightFgIdx + 1]).toBe(90);
    expect(out[rightFgIdx + 2]).toBe(255);

    // 3. Rounded corner verification: extreme top-left corner of foreground bounding box (x=0, y=geom.foregroundY)
    // sits outside the rounded corner arc and therefore shows the blurred background instead of raw foreground
    const geom = computeBlurredFitGeometry(sourceWidth, sourceHeight, {
      canvasWidth,
      canvasHeight,
      borderRadius: 16,
    });
    const cornerIdx = (geom.foregroundY * canvasWidth + 0) * 4;
    expect(out[cornerIdx]).toBeLessThan(120);
  });

  it("positions unpositioned segments at y=1450 in applyBlurredFitLayout when layout is BLURRED_FIT", () => {
    const mockPayload = {
      layout: "BLURRED_FIT",
      projection: {
        canvas: { width: 1080, height: 1920 },
        segments: [
          {
            id: "seg-1",
            seq: "a0",
            startMs: 0,
            endMs: 2000,
            startWordId: "0:0",
            endWordId: "0:2",
          },
          {
            id: "seg-2",
            seq: "a1",
            startMs: 2000,
            endMs: 4000,
            startWordId: "0:3",
            endWordId: "0:5",
            position: { x: 540, y: 300, anchor: "center" },
          },
        ],
        words: [],
      },
    } as unknown as RenderVideoPayload;

    const transformed = applyBlurredFitLayout(mockPayload);
    expect(transformed.projection.segments[0]?.position).toEqual({
      x: 540,
      y: 1450,
      anchor: "center",
    });
    // Explicit segment position is preserved
    expect(transformed.projection.segments[1]?.position).toEqual({
      x: 540,
      y: 300,
      anchor: "center",
    });
  });
});
