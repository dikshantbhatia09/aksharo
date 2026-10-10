import { describe, expect, it } from "vitest";
import {
  clampLogoOpacity,
  clampLogoScalePct,
  computeCornerLogoBounds,
  CornerLogo,
  cornerLogoCommandFor,
  DEFAULT_SAFE_TOP_Y,
  DEFAULT_SAFE_X_MARGIN,
} from "./CornerLogo.js";
import { findVNodeByTestId } from "./SplitScreenView.js";

describe("CornerLogo Overlay Component", () => {
  it("places TOP_LEFT logo strictly at safe margins X = 60px and Y = 180px", () => {
    const bounds = computeCornerLogoBounds({
      position: "TOP_LEFT",
      canvasWidth: 1080,
      canvasHeight: 1920,
      scalePct: 15,
      aspect: 1.0,
    });

    expect(bounds.left).toBe(DEFAULT_SAFE_X_MARGIN); // 60px
    expect(bounds.top).toBe(DEFAULT_SAFE_TOP_Y); // 180px
    expect(bounds.width).toBe(162); // 15% of 1080
    expect(bounds.height).toBe(162);
    expect(bounds.right).toBe(60 + 162);
    expect(bounds.bottom).toBe(180 + 162);
  });

  it("calculates correct bounds for TOP_RIGHT, BOTTOM_LEFT, and BOTTOM_RIGHT", () => {
    const width = 162;
    const height = 162;

    const topRight = computeCornerLogoBounds({
      position: "TOP_RIGHT",
      canvasWidth: 1080,
      canvasHeight: 1920,
      scalePct: 15,
    });
    expect(topRight.left).toBe(1080 - 60 - width); // 858
    expect(topRight.top).toBe(180);

    const bottomLeft = computeCornerLogoBounds({
      position: "BOTTOM_LEFT",
      canvasWidth: 1080,
      canvasHeight: 1920,
      scalePct: 15,
      safeBottomYMargin: 240,
    });
    expect(bottomLeft.left).toBe(60);
    expect(bottomLeft.top).toBe(1920 - 240 - height); // 1518

    const bottomRight = computeCornerLogoBounds({
      position: "BOTTOM_RIGHT",
      canvasWidth: 1080,
      canvasHeight: 1920,
      scalePct: 15,
      safeBottomYMargin: 240,
    });
    expect(bottomRight.left).toBe(1080 - 60 - width); // 858
    expect(bottomRight.top).toBe(1920 - 240 - height); // 1518
  });

  it("clamps scale percentage between 5% and 50%", () => {
    expect(clampLogoScalePct(1)).toBe(5);
    expect(clampLogoScalePct(0)).toBe(5);
    expect(clampLogoScalePct(-10)).toBe(5);
    expect(clampLogoScalePct(15)).toBe(15);
    expect(clampLogoScalePct(35)).toBe(35);
    expect(clampLogoScalePct(50)).toBe(50);
    expect(clampLogoScalePct(80)).toBe(50);
    expect(clampLogoScalePct(Number.NaN)).toBe(15);
  });

  it("clamps opacity between 0.1 and 1.0", () => {
    expect(clampLogoOpacity(0)).toBe(0.1);
    expect(clampLogoOpacity(-0.5)).toBe(0.1);
    expect(clampLogoOpacity(0.05)).toBe(0.1);
    expect(clampLogoOpacity(0.85)).toBe(0.85);
    expect(clampLogoOpacity(1.0)).toBe(1.0);
    expect(clampLogoOpacity(1.5)).toBe(1.0);
    expect(clampLogoOpacity(Number.NaN)).toBe(0.85);
  });

  it("renders Remotion JSX VNode with correct positioning style and img", () => {
    const vnode = CornerLogo({
      logoSrc: "https://assets.aksharo.com/logo.png",
      position: "TOP_LEFT",
      scalePct: 15,
      opacity: 0.85,
    });

    const root = findVNodeByTestId(vnode, "corner-logo");
    expect(root).toBeDefined();
    expect(root?.props.style?.left).toBe(60);
    expect(root?.props.style?.top).toBe(180);
    expect(root?.props.style?.opacity).toBe(0.85);

    const img = findVNodeByTestId(vnode, "corner-logo-img");
    expect(img).toBeDefined();
    expect(img?.props.src).toBe("https://assets.aksharo.com/logo.png");
  });

  it("generates valid Skia DrawCommand matching computed bounds", () => {
    const cmd = cornerLogoCommandFor({
      assetId: "brand_logo_asset_1",
      position: "TOP_LEFT",
      scalePct: 20,
      opacity: 0.9,
      canvasWidth: 1080,
      canvasHeight: 1920,
    });

    expect(cmd.kind).toBe("image");
    if (cmd.kind === "image") {
      expect(cmd.assetId).toBe("brand_logo_asset_1");
      expect(cmd.opacity).toBe(0.9);
      // 20% of 1080 = 216
      expect(cmd.dest).toEqual([60, 180, 60 + 216, 180 + 216]);
    }
  });
});
