import { describe, expect, it } from "vitest";

import {
  buildAudioCrossfadeFiltergraph,
  buildCrossfadeCutCommand,
  buildCutCrossfadeFiltergraph,
  normalizeCutIntervals,
  retainedIntervalsFromCuts,
} from "./cut-pipeline.js";

describe("cut-pipeline", () => {
  describe("normalizeCutIntervals", () => {
    it("handles empty cuts", () => {
      expect(normalizeCutIntervals([], 10)).toEqual([]);
    });

    it("clamps cuts to total duration", () => {
      const cuts = [{ startSec: -1, endSec: 15 }];
      expect(normalizeCutIntervals(cuts, 10)).toEqual([{ startSec: 0, endSec: 10 }]);
    });

    it("merges overlapping and touching cuts", () => {
      const cuts = [
        { startSec: 1.0, endSec: 2.0 },
        { startSec: 1.5, endSec: 3.0 },
        { startSec: 5.0, endSec: 6.0 },
      ];
      expect(normalizeCutIntervals(cuts, 10)).toEqual([
        { startSec: 1.0, endSec: 3.0 },
        { startSec: 5.0, endSec: 6.0 },
      ]);
    });
  });

  describe("retainedIntervalsFromCuts", () => {
    it("returns entire file when there are no cuts", () => {
      expect(retainedIntervalsFromCuts([], 10)).toEqual([{ startSec: 0, endSec: 10 }]);
    });

    it("splits into two segments for a single cut", () => {
      const cuts = [{ startSec: 2.0, endSec: 3.5 }];
      expect(retainedIntervalsFromCuts(cuts, 10)).toEqual([
        { startSec: 0, endSec: 2.0 },
        { startSec: 3.5, endSec: 10 },
      ]);
    });

    it("handles cut at the beginning of the file", () => {
      const cuts = [{ startSec: 0, endSec: 1.5 }];
      expect(retainedIntervalsFromCuts(cuts, 5)).toEqual([{ startSec: 1.5, endSec: 5 }]);
    });

    it("handles cut at the end of the file", () => {
      const cuts = [{ startSec: 4.0, endSec: 5.0 }];
      expect(retainedIntervalsFromCuts(cuts, 5)).toEqual([{ startSec: 0, endSec: 4.0 }]);
    });
  });

  describe("buildAudioCrossfadeFiltergraph", () => {
    it("generates acrossfade filtergraph for 1 cut (2 segments) matching architectural spec", () => {
      const retained = [
        { startSec: 0, endSec: 1.5 },
        { startSec: 2.0, endSec: 5.0 },
      ];
      const graph = buildAudioCrossfadeFiltergraph(retained, {
        crossfadeDurationSec: 0.015,
        curve1: "tri",
        curve2: "tri",
      });

      expect(graph).toContain("[0:a]atrim=0.000:1.500,asetpts=PTS-STARTPTS[a1]");
      expect(graph).toContain("[0:a]atrim=2.000:5.000,asetpts=PTS-STARTPTS[a2]");
      expect(graph).toContain("[a1][a2]acrossfade=d=0.015:c1=tri:c2=tri[aout]");
    });

    it("chains acrossfade filters for multiple cuts (3 segments)", () => {
      const retained = [
        { startSec: 0, endSec: 1.0 },
        { startSec: 1.5, endSec: 3.0 },
        { startSec: 3.8, endSec: 6.0 },
      ];
      const graph = buildAudioCrossfadeFiltergraph(retained);

      expect(graph).toContain("[0:a]atrim=0.000:1.000,asetpts=PTS-STARTPTS[a1]");
      expect(graph).toContain("[0:a]atrim=1.500:3.000,asetpts=PTS-STARTPTS[a2]");
      expect(graph).toContain("[0:a]atrim=3.800:6.000,asetpts=PTS-STARTPTS[a3]");
      expect(graph).toContain("[a1][a2]acrossfade=d=0.015:c1=tri:c2=tri[ax1]");
      expect(graph).toContain("[ax1][a3]acrossfade=d=0.015:c1=tri:c2=tri[aout]");
    });

    it("handles single segment passthrough without acrossfade", () => {
      const retained = [{ startSec: 0, endSec: 5.0 }];
      const graph = buildAudioCrossfadeFiltergraph(retained);
      expect(graph).toBe("[0:a]atrim=start=0.000:end=5.000,asetpts=PTS-STARTPTS[aout]");
    });
  });

  describe("buildCutCrossfadeFiltergraph", () => {
    it("computes removed duration and effective duration accurately", () => {
      const cuts = [{ startSec: 1.0, endSec: 2.0 }, { startSec: 4.0, endSec: 4.5 }];
      const result = buildCutCrossfadeFiltergraph(cuts, 10.0);

      expect(result.totalRemovedSec).toBeCloseTo(1.5);
      expect(result.effectiveDurationSec).toBeCloseTo(8.5);
      expect(result.retainedSegments).toHaveLength(3);
      expect(result.outputAudioLabel).toBe("aout");
    });
  });

  describe("buildCrossfadeCutCommand", () => {
    it("generates full ffmpeg CLI args for audio crossfade", () => {
      const cuts = [{ startSec: 1.0, endSec: 1.5 }];
      const args = buildCrossfadeCutCommand("input.wav", "output.wav", cuts, 5.0);

      expect(args).toContain("-i");
      expect(args).toContain("input.wav");
      expect(args).toContain("-filter_complex");
      expect(args).toContain("output.wav");
    });

    it("includes video trim and concat when hasVideo is true", () => {
      const cuts = [{ startSec: 1.0, endSec: 1.5 }];
      const args = buildCrossfadeCutCommand("input.mp4", "output.mp4", cuts, 5.0, {
        hasVideo: true,
      });

      const filterIdx = args.indexOf("-filter_complex");
      expect(filterIdx).toBeGreaterThan(-1);
      const filterStr = args[filterIdx + 1]!;
      expect(filterStr).toContain("[0:v]trim=");
      expect(filterStr).toContain("concat=n=2:v=1:a=0[vout]");
      expect(args).toContain("-map");
      expect(args).toContain("[vout]");
      expect(args).toContain("[aout]");
    });
  });
});
