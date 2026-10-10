import { describe, expect, it } from "vitest";

import {
  StickerOverlay,
  computeStickerOpacity,
  computeStickerSpringPopScale,
  findVNodeByTestId,
} from "./StickerOverlay.js";

describe("StickerOverlay", () => {
  describe("computeStickerSpringPopScale", () => {
    it("returns 0 before start time", () => {
      expect(computeStickerSpringPopScale(-0.1)).toBe(0);
    });

    it("overshoots to ~1.08 - 1.12x during initial 100ms spring entrance", () => {
      const peakScale = computeStickerSpringPopScale(0.1, 1.0);
      expect(peakScale).toBeGreaterThan(1.05);
      expect(peakScale).toBeLessThanOrEqual(1.15);
    });

    it("settles to exactly base scale after spring duration (250ms)", () => {
      const settledScale = computeStickerSpringPopScale(0.3, 1.0);
      expect(settledScale).toBe(1.0);
    });

    it("respects custom baseScale multipliers", () => {
      const customScale = computeStickerSpringPopScale(0.5, 2.5);
      expect(customScale).toBe(2.5);
    });
  });

  describe("computeStickerOpacity", () => {
    it("returns 0 when current time is outside active interval", () => {
      expect(computeStickerOpacity(1.0, 2.0, 5.0)).toBe(0);
      expect(computeStickerOpacity(6.0, 2.0, 5.0)).toBe(0);
    });

    it("returns 1.0 during steady middle playback", () => {
      expect(computeStickerOpacity(3.5, 2.0, 5.0)).toBe(1.0);
    });

    it("fades out during exit ramp", () => {
      const fading = computeStickerOpacity(4.95, 2.0, 5.0);
      expect(fading).toBeLessThan(1.0);
      expect(fading).toBeGreaterThan(0.0);
    });
  });

  describe("StickerOverlay component tree", () => {
    it("renders OffthreadVideo for transparent WebM stickers with spring transform", () => {
      const vnode = StickerOverlay({
        stickerSrc: "https://assets.aksharo.com/stickers/curated/arrow.webm",
        startSec: 2.0,
        endSec: 5.0,
        currentTimeSec: 2.1,
        x: 0.5,
        y: 0.3,
        scale: 1.0,
        rotation: 15,
        isTransparent: true,
      });

      const root = findVNodeByTestId(vnode, "sticker-overlay-root");
      expect(root).toBeDefined();

      const container = findVNodeByTestId(vnode, "sticker-container");
      expect(container).toBeDefined();
      const style = container?.props.style as Record<string, unknown> | undefined;
      expect(style?.left).toBe("540px"); // 0.5 * 1080
      expect(style?.top).toBe("576px"); // 0.3 * 1920
      expect(String(style?.transform)).toContain("rotate(15deg)");

      const video = findVNodeByTestId(vnode, "sticker-media-video");
      expect(video).toBeDefined();
      expect(video?.props.src).toContain("arrow.webm");
      const videoStyle = video?.props.style as Record<string, unknown> | undefined;
      expect(videoStyle?.backgroundColor).toBe("transparent");
    });

    it("renders img element for GIF / WebP stickers", () => {
      const vnode = StickerOverlay({
        stickerSrc: "https://media.giphy.com/media/funny.gif",
        startSec: 1.0,
        endSec: 4.0,
        currentTimeSec: 2.0,
        x: 0.8,
        y: 0.2,
      });

      const img = findVNodeByTestId(vnode, "sticker-media-image");
      expect(img).toBeDefined();
      expect(img?.props.src).toContain("funny.gif");
      const imgStyle = img?.props.style as Record<string, unknown> | undefined;
      expect(imgStyle?.objectFit).toBe("contain");
    });

    it("renders background mainVideoSrc when provided", () => {
      const vnode = StickerOverlay({
        stickerSrc: "https://assets.aksharo.com/stickers/curated/skull.webm",
        mainVideoSrc: "https://assets.aksharo.com/raw/speaker.mp4",
        startSec: 0.0,
        endSec: 3.0,
        currentTimeSec: 1.0,
      });

      const mainVideo = findVNodeByTestId(vnode, "sticker-main-video");
      expect(mainVideo).toBeDefined();
      expect(mainVideo?.props.src).toBe("https://assets.aksharo.com/raw/speaker.mp4");
    });
  });
});
