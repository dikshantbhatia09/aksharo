import { describe, expect, it } from "vitest";

import {
  AnimatedProgressBar,
  computeProgress,
  computeProgressBarWidth,
  computeProgressBarY,
  computeRadialDashOffset,
  DEFAULT_CANVAS_HEIGHT,
  DEFAULT_CANVAS_WIDTH,
  validateSafeZoneCompliance,
} from "./AnimatedProgressBar.js";
import { findVNodeByTestId } from "./SplitScreenView.js";

describe("Dynamic Animated Progress Bars & Timers (Pillar 6 §05)", () => {
  describe("Mathematical Duration & Progress Calculation", () => {
    it("calculates accurate normalized progress across frames", () => {
      expect(computeProgress(0, 100)).toBe(0.0);
      expect(computeProgress(50, 100)).toBe(0.5);
      expect(computeProgress(100, 100)).toBe(1.0);
    });

    it("calculates accurate normalized progress across seconds", () => {
      expect(computeProgress(undefined, undefined, 0, 10)).toBe(0.0);
      expect(computeProgress(undefined, undefined, 5, 10)).toBe(0.5);
      expect(computeProgress(undefined, undefined, 10, 10)).toBe(1.0);
    });

    it("clamps progress to [0.0, 1.0] under boundary overshoot", () => {
      expect(computeProgress(-10, 100)).toBe(0.0);
      expect(computeProgress(150, 100)).toBe(1.0);
    });

    it("calculates progress bar width at frame 0, frame 50%, and final frame", () => {
      // SLA unit test requirement: frame 0, frame 50%, final frame
      expect(computeProgressBarWidth(0.0, 1080)).toBe(0);
      expect(computeProgressBarWidth(0.5, 1080)).toBe(540);
      expect(computeProgressBarWidth(1.0, 1080)).toBe(1080);
    });

    it("calculates radial stroke-dashoffset accurately", () => {
      const radius = 32;
      const circumference = 2 * Math.PI * radius; // ~201.06
      expect(computeRadialDashOffset(0.0, radius)).toBeCloseTo(circumference, 1);
      expect(computeRadialDashOffset(0.5, radius)).toBeCloseTo(circumference / 2, 1);
      expect(computeRadialDashOffset(1.0, radius)).toBe(0);
    });
  });

  describe("Safe-Zone Compliance & Occlusion Avoidance", () => {
    it("guarantees progress bar never renders inside TikTok bottom occlusion zone", () => {
      // TikTok bottom chrome begins at Y = 1480 on a 1080x1920 canvas
      const posY = computeProgressBarY("BOTTOM_SAFE", DEFAULT_CANVAS_HEIGHT);
      expect(posY).toBe(1450);
      expect(posY).toBeLessThan(1480);

      const heightPx = 6;
      expect(posY + heightPx).toBeLessThanOrEqual(1480);

      // Verify safe zone compliance helper
      expect(validateSafeZoneCompliance(posY, heightPx, DEFAULT_CANVAS_HEIGHT, "tiktok")).toBe(true);
      expect(validateSafeZoneCompliance(1550, heightPx, DEFAULT_CANVAS_HEIGHT, "tiktok")).toBe(false);
    });

    it("places TOP progress bar safely below platform top status/search chrome", () => {
      const posY = computeProgressBarY("TOP", DEFAULT_CANVAS_HEIGHT);
      expect(posY).toBe(160);
      expect(validateSafeZoneCompliance(posY, 6, DEFAULT_CANVAS_HEIGHT, "universal")).toBe(true);
      // y = 50 is inside top exclusion zone (0..160)
      expect(validateSafeZoneCompliance(50, 6, DEFAULT_CANVAS_HEIGHT, "universal")).toBe(false);
    });
  });

  describe("AnimatedProgressBar Remotion Component Tree", () => {
    it("renders SLIM_LINE horizontal bar with track and active fill", () => {
      const vnode = AnimatedProgressBar({
        type: "SLIM_LINE",
        position: "BOTTOM_SAFE",
        heightPx: 6,
        fillColor: "#00FFA3",
        currentFrame: 30,
        totalFrames: 60, // 50% progress
        canvasWidth: 1080,
      });

      const root = findVNodeByTestId(vnode, "animated-progress-bar-root");
      expect(root).toBeDefined();
      expect(root?.props["data-type"]).toBe("SLIM_LINE");
      expect(root?.props["data-progress"]).toBe(0.5);
      expect(root?.props.style?.top).toBe("1450px");

      const track = findVNodeByTestId(vnode, "progress-bar-track");
      expect(track).toBeDefined();

      const fill = findVNodeByTestId(vnode, "progress-bar-fill");
      expect(fill).toBeDefined();
      expect(fill?.props.style?.width).toBe("540px");
      expect(fill?.props.style?.background).toBe("#00FFA3");
    });

    it("renders NEON_GRADIENT with animated glowing lead cursor dot", () => {
      const vnode = AnimatedProgressBar({
        type: "NEON_GRADIENT",
        position: "BOTTOM_SAFE",
        heightPx: 8,
        fillColor: "#00FFA3",
        currentFrame: 30,
        totalFrames: 60, // 50%
        canvasWidth: 1080,
      });

      const fill = findVNodeByTestId(vnode, "progress-bar-fill");
      expect(fill?.props.style?.boxShadow).toContain("0 0 12px");

      const leadDot = findVNodeByTestId(vnode, "progress-bar-lead-dot");
      expect(leadDot).toBeDefined();
      expect(leadDot?.props.style?.left).toBe("540px");
      expect(leadDot?.props.style?.boxShadow).toContain("#00FFA3");
    });

    it("renders RADIAL_DIAL countdown clock with SVG circle and time text", () => {
      const vnode = AnimatedProgressBar({
        type: "RADIAL_DIAL",
        currentTimeSec: 6,
        durationSec: 10, // 60%
        showCountdownText: true,
      });

      const root = findVNodeByTestId(vnode, "animated-progress-bar-root");
      expect(root).toBeDefined();
      expect(root?.props["data-type"]).toBe("RADIAL_DIAL");

      const svg = findVNodeByTestId(vnode, "radial-dial-svg");
      expect(svg).toBeDefined();

      const circleTrack = findVNodeByTestId(vnode, "radial-dial-track");
      expect(circleTrack).toBeDefined();

      const circleFill = findVNodeByTestId(vnode, "radial-dial-fill");
      expect(circleFill).toBeDefined();

      const text = findVNodeByTestId(vnode, "radial-countdown-text");
      expect(text).toBeDefined();
      expect(text?.props.children).toContain("4s"); // 10 - 6 = 4s
    });

    it("returns empty fragment when enabled is false", () => {
      const vnode = AnimatedProgressBar({
        enabled: false,
      });

      expect(vnode.type).toBe("fragment");
      expect(findVNodeByTestId(vnode, "animated-progress-bar-root")).toBeUndefined();
    });
  });
});
