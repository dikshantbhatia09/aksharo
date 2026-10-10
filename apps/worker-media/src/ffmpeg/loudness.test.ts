import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  EMPTY_LOUDNESS,
  PLATFORM_LOUDNESS_TARGETS,
  buildLoudnormPass1Filter,
  buildLoudnormPass2Filter,
  measureLoudnormStats,
  normalizeAudioTwoPass,
  parseLoudness,
  parseLoudnormJson,
  parseSilences,
  resolveLoudnessTarget,
  verifyLoudnessCompliance,
} from "./loudness.js";

/** A real ffmpeg 9 report, trimmed to the lines that matter. */
const REPORT = `
[silencedetect @ 000001f0] silence_start: 0
[silencedetect @ 000001f0] silence_end: 1.2 | silence_duration: 1.2
[silencedetect @ 000001f0] silence_start: 6.5
[silencedetect @ 000001f0] silence_end: 8.1 | silence_duration: 1.6
[Parsed_ebur128_0 @ 000002a0] Summary:

  Integrated loudness:
    I:         -18.4 LUFS
    Threshold: -28.6 LUFS

  Loudness range:
    LRA:         6.2 LU
    Threshold: -38.6 LUFS
    LRA low:   -21.4 LUFS
    LRA high:  -15.2 LUFS

  True peak:
    Peak:       -1.5 dBFS
`;

describe("parseSilences", () => {
  it("pairs starts with ends", () => {
    expect(parseSilences(REPORT)).toEqual([
      { startMs: 0, endMs: 1_200 },
      { startMs: 6_500, endMs: 8_100 },
    ]);
  });

  it("drops a start with no end — a file that finished silent", () => {
    // Zipping the two lists by index instead of matching them in order would leave
    // an unbalanced pair here and shift every span after it.
    const trailing = `${REPORT}[silencedetect @ x] silence_start: 9.5\n`;
    expect(parseSilences(trailing)).toHaveLength(2);
  });

  it("finds nothing in a report with no silence in it", () => {
    expect(parseSilences("[Parsed_ebur128_0] Summary:\n  I: -14.0 LUFS\n")).toEqual([]);
  });
});

describe("parseLoudness", () => {
  it("reads the three EBU R128 figures by label", () => {
    const report = parseLoudness(REPORT, 10_000);
    expect(report.loudnessLufs).toBe(-18.4);
    expect(report.loudnessRangeLu).toBe(6.2);
    expect(report.truePeakDbfs).toBe(-1.5);
  });

  it("computes the silent fraction of the timeline", () => {
    // 1.2 s + 1.6 s of 10 s.
    expect(parseLoudness(REPORT, 10_000).silenceRatio).toBeCloseTo(0.28, 3);
  });

  it("never reports a ratio above one, whatever the spans say", () => {
    const overlong = "silence_start: 0\nsilence_end: 30\n";
    expect(parseLoudness(overlong, 10_000).silenceRatio).toBe(1);
  });

  it("leaves the ratio unknown when the duration is unknown", () => {
    expect(parseLoudness(REPORT, 0).silenceRatio).toBeNull();
  });

  it("treats a silent track's `-inf` peak as unknown rather than as a number", () => {
    // `-inf dBFS` is true and is not something a JSON column can hold.
    const silent = "  True peak:\n    Peak:       -inf dBFS\n";
    expect(parseLoudness(silent, 1_000).truePeakDbfs).toBeNull();
  });

  it("answers nulls for a report it did not recognise at all", () => {
    const empty = parseLoudness("ffmpeg said nothing useful", 1_000);
    expect(empty.loudnessLufs).toBeNull();
    expect(empty.loudnessRangeLu).toBeNull();
    expect(empty.silences).toEqual([]);
  });

  it("returns the longest spans, in timeline order", () => {
    const many = Array.from({ length: 80 }, (_unused, index) => {
      const start = index * 10;
      // Later spans are longer, so the cap has something to choose between.
      return `silence_start: ${String(start)}\nsilence_end: ${String(start + index / 10 + 0.5)}\n`;
    }).join("");
    const report = parseLoudness(many, 1_000_000);
    expect(report.silences.length).toBeLessThanOrEqual(50);
    const starts = report.silences.map((span) => span.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});

describe("EMPTY_LOUDNESS", () => {
  it("is what a skipped or failed pass reports — nulls, never zeros", () => {
    // Zero LUFS is deafening; "we did not measure" has to be distinguishable.
    expect(EMPTY_LOUDNESS.loudnessLufs).toBeNull();
    expect(EMPTY_LOUDNESS.silenceRatio).toBeNull();
    expect(EMPTY_LOUDNESS.silences).toEqual([]);
  });
});

const runExec = promisify(execFile);

describe("resolveLoudnessTarget", () => {
  it("resolves YouTube Shorts / YouTube to -14.0 LUFS and -1.0 dBTP", () => {
    expect(resolveLoudnessTarget("youtube-shorts")).toEqual({
      targetI: -14.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
    expect(resolveLoudnessTarget("shorts")).toEqual(PLATFORM_LOUDNESS_TARGETS["youtube-shorts"]);
    expect(resolveLoudnessTarget("youtube-4k")).toEqual(PLATFORM_LOUDNESS_TARGETS["youtube-shorts"]);
  });

  it("resolves TikTok and Instagram Reels to -15.0 LUFS and -1.0 dBTP", () => {
    expect(resolveLoudnessTarget("tiktok")).toEqual({
      targetI: -15.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
    expect(resolveLoudnessTarget("reels")).toEqual({
      targetI: -15.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
    expect(resolveLoudnessTarget("instagram")).toEqual({
      targetI: -15.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
  });

  it("defaults to -14.0 LUFS for unknown or omitted platform", () => {
    expect(resolveLoudnessTarget()).toEqual({
      targetI: -14.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
    expect(resolveLoudnessTarget("unknown-platform")).toEqual(PLATFORM_LOUDNESS_TARGETS["default"]);
  });
});

describe("parseLoudnormJson", () => {
  it("parses real JSON stats block printed by loudnorm filter", () => {
    const stderr = `
[Parsed_loudnorm_0 @ 000001f0] 
{
	"input_i" : "-22.40",
	"input_tp" : "-2.10",
	"input_lra" : "9.20",
	"input_thresh" : "-33.50",
	"output_i" : "-14.10",
	"output_tp" : "-1.00",
	"output_lra" : "6.80",
	"output_thresh" : "-24.20",
	"normalization_type" : "dynamic",
	"target_offset" : "0.20"
}
[out#0/null @ 000001f0] video:0KiB audio:100KiB
`;
    const parsed = parseLoudnormJson(stderr);
    expect(parsed).toEqual({
      inputI: -22.4,
      inputTp: -2.1,
      inputLra: 9.2,
      inputThresh: -33.5,
      targetOffset: 0.2,
    });
  });

  it("returns null for stderr without loudnorm json", () => {
    expect(parseLoudnormJson("ffmpeg version 9.0\nsome ordinary log line")).toBeNull();
  });
});

describe("buildLoudnormPass1Filter and buildLoudnormPass2Filter", () => {
  it("builds Pass 1 filter with target parameters and print_format=json", () => {
    const filter = buildLoudnormPass1Filter({ targetI: -14, targetTp: -1, targetLra: 7 });
    expect(filter).toBe("loudnorm=I=-14.0:tp=-1.0:LRA=7.0:print_format=json");
  });

  it("builds Pass 2 linear filter with measured stats", () => {
    const filter = buildLoudnormPass2Filter(
      { targetI: -14, targetTp: -1, targetLra: 7 },
      {
        inputI: -22.4,
        inputTp: -2.1,
        inputLra: 9.2,
        inputThresh: -33.5,
        targetOffset: 0.2,
      },
      true,
    );
    expect(filter).toBe(
      "loudnorm=I=-14.0:tp=-1.0:LRA=7.0:measured_I=-22.40:measured_tp=-2.10:measured_LRA=9.20:measured_thresh=-33.50:offset=0.20:linear=true",
    );
  });
});

describe("verifyLoudnessCompliance", () => {
  it("returns true when measured LUFS is within target ± 0.5 LUFS and TP <= -1.0 dBTP", () => {
    expect(verifyLoudnessCompliance(-14.2, -14.0, -1.2)).toBe(true);
    expect(verifyLoudnessCompliance(-13.8, -14.0, -1.0)).toBe(true);
  });

  it("returns false when outside tolerance or clipping", () => {
    expect(verifyLoudnessCompliance(-15.0, -14.0, -1.0)).toBe(false);
    expect(verifyLoudnessCompliance(-14.0, -14.0, -0.5)).toBe(false);
  });
});

describe("Two-Pass Loudness Normalizer (FFmpeg Integration)", () => {
  it("normalizes quiet audio (-26 LUFS) to YouTube target -14.0 ± 0.4 LUFS and TP <= -1.0 dBTP", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "loudnorm-test-"));
    try {
      const inputWav = join(scratchDir, "quiet.wav");
      const outputWav = join(scratchDir, "normalized_yt.wav");

      await runExec("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3",
        "-af",
        "volume=-26dB",
        "-c:a",
        "pcm_s16le",
        inputWav,
      ]);

      const result = await normalizeAudioTwoPass({
        binary: "ffmpeg",
        source: inputWav,
        destination: outputWav,
        target: resolveLoudnessTarget("youtube-shorts"),
      });

      expect(result.success).toBe(true);
      expect(result.stats).not.toBeNull();
      expect(result.filter).toContain("linear=true");

      const postMeasurement = await measureLoudnormStats({
        binary: "ffmpeg",
        source: outputWav,
        target: resolveLoudnessTarget("youtube-shorts"),
      });

      expect(postMeasurement).not.toBeNull();
      expect(Math.abs(postMeasurement!.inputI - -14.0)).toBeLessThanOrEqual(0.4);
      expect(postMeasurement!.inputTp).toBeLessThanOrEqual(-0.95);
      expect(verifyLoudnessCompliance(postMeasurement!.inputI, -14.0, postMeasurement!.inputTp)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("normalizes loud audio (-8 LUFS) to TikTok/Reels target -15.0 ± 0.4 LUFS and TP <= -1.0 dBTP", async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), "loudnorm-test-"));
    try {
      const inputWav = join(scratchDir, "loud.wav");
      const outputWav = join(scratchDir, "normalized_tiktok.wav");

      await runExec("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=1000:duration=3",
        "-af",
        "volume=0dB",
        "-c:a",
        "pcm_s16le",
        inputWav,
      ]);

      const result = await normalizeAudioTwoPass({
        binary: "ffmpeg",
        source: inputWav,
        destination: outputWav,
        target: resolveLoudnessTarget("tiktok"),
      });

      expect(result.success).toBe(true);
      expect(result.stats).not.toBeNull();
      expect(result.filter).toContain("linear=true");

      const postMeasurement = await measureLoudnormStats({
        binary: "ffmpeg",
        source: outputWav,
        target: resolveLoudnessTarget("tiktok"),
      });

      expect(postMeasurement).not.toBeNull();
      expect(Math.abs(postMeasurement!.inputI - -15.0)).toBeLessThanOrEqual(0.4);
      expect(postMeasurement!.inputTp).toBeLessThanOrEqual(-0.95);
      expect(verifyLoudnessCompliance(postMeasurement!.inputI, -15.0, postMeasurement!.inputTp)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

