import { describe, expect, it } from "vitest";

import {
  computeCutPunchInKeyframes,
  DEFAULT_PUNCH_IN_SCALE,
  isFillerCut,
  punchInCropRect,
} from "./punch-in.js";

import type { RenderManifest } from "@montaj/render-manifest";
import type { TimeMap } from "@montaj/timemap";
import type { ProjectedWord } from "../queues.js";

describe("punch-in camera zoom jump cut masking", () => {
  describe("punchInCropRect", () => {
    it("returns full frame rect for scale 1.0", () => {
      expect(punchInCropRect(1.0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    });

    it("returns centered 1.15x punch-in crop rect", () => {
      const rect = punchInCropRect(1.15);
      expect(rect.w).toBeCloseTo(0.8696, 3);
      expect(rect.h).toBeCloseTo(0.8696, 3);
      expect(rect.x).toBeCloseTo(0.0652, 3);
      expect(rect.y).toBeCloseTo(0.0652, 3);
      // Center check: x + w/2 == 0.5, y + h/2 == 0.5
      expect(rect.x + rect.w / 2).toBeCloseTo(0.5, 3);
      expect(rect.y + rect.h / 2).toBeCloseTo(0.5, 3);
    });
  });

  describe("isFillerCut", () => {
    const words: ProjectedWord[] = [
      { wid: "0:0", s: 0, e: 1000, t: "hello" },
      { wid: "0:1", s: 1000, e: 1500, t: "um", filler: true },
      { wid: "0:2", s: 1500, e: 2500, t: "world" },
    ];

    it("identifies cut overlapping filler word", () => {
      expect(isFillerCut(900, 1600, words)).toBe(true);
    });

    it("returns false for cut not overlapping filler word", () => {
      expect(isFillerCut(0, 500, words)).toBe(false);
    });
  });

  describe("computeCutPunchInKeyframes", () => {
    const mockManifest: RenderManifest = {
      exportId: "01JCEXPORT000000000000000",
      workspaceId: "01JCWS00000000000000000",
      projectId: "01JCPROJ000000000000000",
      revision: 1,
      source: { key: "source.mp4", durationMs: 10000, width: 1080, height: 1920 },
      output: {
        container: "mp4",
        videoCodec: "h264",
        width: 1080,
        height: 1920,
        fps: 30,
        kind: "video",
      },
      audio: { strategy: "source", codec: "aac", bitrateKbps: 192 },
      styles: { defaultStyleId: "default" },
      watermark: null,
      timemap: {
        sourceDurationMs: 10000,
        edits: [{ type: "cut", sourceStartMs: 2000, sourceEndMs: 3000 }],
      },
    };

    it("returns empty keyframes for unedited timemap with 1 retained span", () => {
      const mockTimemap: TimeMap = {
        sourceDurationMs: 10000,
        outputDurationMs: 10000,
        spans: [
          {
            index: 0,
            kind: "retained",
            sourceStart: 0,
            sourceEnd: 10000,
            outputStart: 0,
            outputEnd: 10000,
            factor: 1,
          },
        ],
        keyframes: [],
        mapTime: (t) => t,
        unmapTime: (t) => t,
        mapRange: (s, e) => [s, e],
        unmapRange: (s, e) => [s, e],
      };

      const keyframes = computeCutPunchInKeyframes(mockManifest, mockTimemap);
      expect(keyframes).toEqual([]);
    });

    it("toggles scale from 1.0x to 1.15x at the exact cut frame", () => {
      // 1 cut from 2000ms to 3000ms (1000ms cut).
      // Span 1: source 0..2000 -> output 0..2000
      // Span 2: source 3000..6000 -> output 2000..5000
      const mockTimemap: TimeMap = {
        sourceDurationMs: 6000,
        outputDurationMs: 5000,
        spans: [
          {
            index: 0,
            kind: "retained",
            sourceStart: 0,
            sourceEnd: 2000,
            outputStart: 0,
            outputEnd: 2000,
            factor: 1,
          },
          {
            index: 1,
            kind: "retained",
            sourceStart: 3000,
            sourceEnd: 6000,
            outputStart: 2000,
            outputEnd: 5000,
            factor: 1,
          },
        ],
        keyframes: [],
        mapTime: (t) => t,
        unmapTime: (t) => t,
        mapRange: (s, e) => [s, e],
        unmapRange: (s, e) => [s, e],
      };

      const keyframes = computeCutPunchInKeyframes(mockManifest, mockTimemap, undefined, {
        forceAllCuts: true,
      });

      expect(keyframes.length).toBeGreaterThanOrEqual(3);
      // Initial: scale 1.0 at t=0 (full frame)
      expect(keyframes[0]!.tMs).toBe(0);
      expect(keyframes[0]!.rect.w).toBe(1.0);

      // Pre-cut hold at t=1999: scale 1.0
      const preCut = keyframes.find((k) => k.tMs === 1999);
      expect(preCut?.rect.w).toBe(1.0);

      // Instantaneous punch-in at cut frame t=2000: scale 1.15 (w = 0.8696)
      const atCut = keyframes.find((k) => k.tMs === 2000);
      expect(atCut).toBeDefined();
      expect(atCut!.rect.w).toBeCloseTo(0.8696, 3);
      expect(atCut!.rect.h).toBeCloseTo(0.8696, 3);

      // Final frame at outputDurationMs: holds 1.15
      const last = keyframes[keyframes.length - 1]!;
      expect(last.tMs).toBe(5000);
      expect(last.rect.w).toBeCloseTo(0.8696, 3);
    });

    it("toggles 1.0x -> 1.15x -> 1.0x across multiple cut frames", () => {
      // 2 cuts at output time 2000ms and 4000ms
      const mockTimemap: TimeMap = {
        sourceDurationMs: 8000,
        outputDurationMs: 6000,
        spans: [
          {
            index: 0,
            kind: "retained",
            sourceStart: 0,
            sourceEnd: 2000,
            outputStart: 0,
            outputEnd: 2000,
            factor: 1,
          },
          {
            index: 1,
            kind: "retained",
            sourceStart: 3000,
            sourceEnd: 5000,
            outputStart: 2000,
            outputEnd: 4000,
            factor: 1,
          },
          {
            index: 2,
            kind: "retained",
            sourceStart: 6000,
            sourceEnd: 8000,
            outputStart: 4000,
            outputEnd: 6000,
            factor: 1,
          },
        ],
        keyframes: [],
        mapTime: (t) => t,
        unmapTime: (t) => t,
        mapRange: (s, e) => [s, e],
        unmapRange: (s, e) => [s, e],
      };

      const keyframes = computeCutPunchInKeyframes(mockManifest, mockTimemap, undefined, {
        forceAllCuts: true,
      });

      // At cut 1 (t=2000): punched in to 1.15x (w = 0.8696)
      const cut1 = keyframes.find((k) => k.tMs === 2000);
      expect(cut1?.rect.w).toBeCloseTo(0.8696, 3);

      // At cut 2 (t=4000): punched back out to 1.0x (w = 1.0)
      const cut2 = keyframes.find((k) => k.tMs === 4000);
      expect(cut2?.rect.w).toBe(1.0);
    });
  });
});
