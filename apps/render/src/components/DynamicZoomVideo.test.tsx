import { describe, expect, it } from "vitest";

import {
  DynamicZoomVideo,
  buildZoompanFilter,
  clampOrigin,
  computeZoomTransform,
  normalizeKeyframes,
  type ZoomKeyframe,
} from "./DynamicZoomVideo.js";

describe("DynamicZoomVideo (Pillar 6 §03: Dynamic Auto-Zoom Pacing)", () => {
  describe("clampOrigin", () => {
    it("clamps extreme coordinates to prevent empty canvas bleed and forehead clipping", () => {
      // Too far left/top
      const leftTop = clampOrigin(0.05, 0.05);
      expect(leftTop.originX).toBe(0.2);
      expect(leftTop.originY).toBe(0.2);

      // Too far right/bottom (chest/torso)
      const rightBottom = clampOrigin(0.95, 0.9);
      expect(rightBottom.originX).toBe(0.8);
      expect(rightBottom.originY).toBe(0.6);
    });

    it("preserves eye-line within the upper-third grid Y in [0.28, 0.38]", () => {
      const eyeLine = clampOrigin(0.48, 0.32);
      expect(eyeLine.originX).toBe(0.48);
      expect(eyeLine.originY).toBe(0.32);
      expect(eyeLine.originY).toBeGreaterThanOrEqual(0.28);
      expect(eyeLine.originY).toBeLessThanOrEqual(0.38);
    });
  });

  describe("normalizeKeyframes", () => {
    it("converts MKF2 format (tMs, zoom, cx, cy) to ZoomKeyframe format", () => {
      const mkf2Frames = [
        { tMs: 0, zoom: 1.0, cx: 0.5, cy: 0.35, ease: "linear" },
        { tMs: 180, zoom: 1.18, cx: 0.5, cy: 0.35, ease: "inOut" },
      ];
      const normalized = normalizeKeyframes(mkf2Frames);
      expect(normalized).toHaveLength(2);
      expect(normalized[0]!.timeSec).toBe(0);
      expect(normalized[0]!.scale).toBe(1.0);
      expect(normalized[1]!.timeSec).toBe(0.18);
      expect(normalized[1]!.scale).toBe(1.18);
      expect(normalized[1]!.transition).toBe("EASE");
    });
  });

  describe("computeZoomTransform", () => {
    it("returns default 1.0x centered transform when keyframes are empty", () => {
      const transform = computeZoomTransform([], 2.5);
      expect(transform.scale).toBe(1.0);
      expect(transform.originX).toBe(0.5);
      expect(transform.originY).toBe(0.35);
      expect(transform.transform).toBe("scale(1)");
      expect(transform.transformOrigin).toBe("50% 35%");
    });

    it("interpolates smooth ease punch-in (1.0x to 1.18x)", () => {
      const keyframes: ZoomKeyframe[] = [
        { timeSec: 0, scale: 1.0, originX: 0.5, originY: 0.35, transition: "linear" },
        { timeSec: 0.2, scale: 1.2, originX: 0.5, originY: 0.35, transition: "EASE" },
      ];

      // At start
      const atStart = computeZoomTransform(keyframes, 0);
      expect(atStart.scale).toBe(1.0);

      // Midpoint
      const atMid = computeZoomTransform(keyframes, 0.1);
      expect(atMid.scale).toBeGreaterThan(1.0);
      expect(atMid.scale).toBeLessThan(1.2);

      // At destination
      const atEnd = computeZoomTransform(keyframes, 0.2);
      expect(atEnd.scale).toBe(1.2);
      expect(atEnd.transform).toBe("scale(1.2)");
    });

    it("handles Instant Jump Cut punch (holds start scale until boundary)", () => {
      const keyframes: ZoomKeyframe[] = [
        { timeSec: 1.0, scale: 1.0, originX: 0.45, originY: 0.33, transition: "linear" },
        { timeSec: 1.01, scale: 1.18, originX: 0.45, originY: 0.33, transition: "JUMP" },
      ];

      // Just before jump cut
      const before = computeZoomTransform(keyframes, 1.0);
      expect(before.scale).toBe(1.0);

      // Past cut frame
      const after = computeZoomTransform(keyframes, 1.05);
      expect(after.scale).toBe(1.18);
    });

    it("handles Ken Burns slow tension creep (smooth cubic progression)", () => {
      const keyframes: ZoomKeyframe[] = [
        { timeSec: 0, scale: 1.0, originX: 0.5, originY: 0.35, transition: "linear" },
        { timeSec: 3.0, scale: 1.08, originX: 0.5, originY: 0.35, transition: "CREEP" },
      ];

      const mid = computeZoomTransform(keyframes, 1.5);
      expect(mid.scale).toBeCloseTo(1.04, 1);
    });
  });

  describe("DynamicZoomVideo component", () => {
    it("renders container div and OffthreadVideo with face-anchored transform styles", () => {
      const vnode = DynamicZoomVideo({
        src: "https://example.com/proxy540.mp4",
        currentTimeSec: 0.18,
        keyframes: [
          { timeSec: 0, scale: 1.0, originX: 0.48, originY: 0.32, transition: "linear" },
          { timeSec: 0.18, scale: 1.18, originX: 0.48, originY: 0.32, transition: "EASE" },
        ],
      });

      expect(vnode.type).toBe("div");
      expect(vnode.props["data-testid"]).toBe("dynamic-zoom-video");

      const children = vnode.props.children;
      expect(children).toHaveLength(1);

      const videoNode = children[0] as { type: string; props: Record<string, unknown> };
      expect(videoNode.type).toBe("OffthreadVideo");
      expect(videoNode.props["src"]).toBe("https://example.com/proxy540.mp4");

      const style = videoNode.props["style"] as Record<string, string>;
      expect(style.transform).toBe("scale(1.18)");
      expect(style.transformOrigin).toBe("48% 32%");
    });
  });

  describe("buildZoompanFilter", () => {
    it("generates an FFmpeg zoompan filter expression with face-anchored coordinates", () => {
      const keyframes: ZoomKeyframe[] = [
        { timeSec: 0, scale: 1.0, originX: 0.5, originY: 0.35 },
        { timeSec: 2.0, scale: 1.2, originX: 0.5, originY: 0.35 },
      ];
      const filter = buildZoompanFilter(keyframes, 2.0, 30);
      expect(filter).toContain("zoompan=z=");
      expect(filter).toContain("1.20");
      expect(filter).toContain("s=1080x1920");
      expect(filter).toContain("fps=30");
    });
  });
});
