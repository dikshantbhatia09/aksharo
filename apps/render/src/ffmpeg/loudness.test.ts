import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { RenderManifestSchema, withSignature } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";
import { buildTimeMap } from "@montaj/timemap";

import {
  PLATFORM_LOUDNESS_TARGETS,
  buildAudioPass1Plan,
  buildLoudnormPass1Filter,
  buildLoudnormPass2Filter,
  measureAudioLoudnormPass1,
  parseLoudnormJson,
  resolveLoudnessTarget,
} from "./loudness.js";

const run = promisify(execFile);

function makeManifest(overrides: Parameters<typeof fixtureManifest>[0] = {}) {
  return RenderManifestSchema.parse(withSignature(fixtureManifest(overrides), "test-secret"));
}

describe("resolveLoudnessTarget", () => {
  it("resolves YouTube Shorts and 4K to -14.0 LUFS", () => {
    expect(resolveLoudnessTarget("youtube-shorts")).toEqual({
      targetI: -14.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
    expect(resolveLoudnessTarget("shorts")).toEqual(PLATFORM_LOUDNESS_TARGETS["youtube-shorts"]);
    expect(resolveLoudnessTarget("youtube-4k")).toEqual(PLATFORM_LOUDNESS_TARGETS["youtube-shorts"]);
  });

  it("resolves TikTok and Instagram to -15.0 LUFS", () => {
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
    expect(resolveLoudnessTarget("instagram-story")).toEqual({
      targetI: -15.0,
      targetTp: -1.0,
      targetLra: 7.0,
    });
  });

  it("defaults to -14.0 LUFS when omitted or unknown", () => {
    expect(resolveLoudnessTarget()).toEqual(PLATFORM_LOUDNESS_TARGETS["default"]);
    expect(resolveLoudnessTarget("other")).toEqual(PLATFORM_LOUDNESS_TARGETS["default"]);
  });
});

describe("buildAudioPass1Plan", () => {
  it("returns null when audio strategy is none or no audio stream", () => {
    const manifest = makeManifest({ audio: { strategy: "none", codec: "aac", bitrateKbps: 192 } });
    const plan = buildAudioPass1Plan({
      manifest,
      sourcePath: "/tmp/source.mp4",
      sourceHasAudio: false,
      spans: [],
      outputDurationMs: 5000,
      target: resolveLoudnessTarget("shorts"),
    });
    expect(plan).toBeNull();
  });

  it("builds unedited single-input pass 1 command", () => {
    const manifest = makeManifest();
    const map = buildTimeMap({ sourceDurationMs: 10_000, edits: [] });
    const plan = buildAudioPass1Plan({
      manifest,
      sourcePath: "/tmp/source.mp4",
      sourceHasAudio: true,
      spans: map.spans,
      outputDurationMs: 10_000,
      target: resolveLoudnessTarget("shorts"),
    });

    expect(plan).not.toBeNull();
    expect(plan!.args).toContain("-i");
    expect(plan!.args).toContain("/tmp/source.mp4");
    expect(plan!.args).toContain("-vn");
    expect(plan!.args.join(" ")).toContain("loudnorm=I=-14.0:tp=-1.0:LRA=7.0:print_format=json");
    expect(plan!.args).toContain("-f");
    expect(plan!.args).toContain("null");
  });

  it("builds cut concatenation filter in pass 1 command", () => {
    const manifest = makeManifest();
    const map = buildTimeMap({
      sourceDurationMs: 10_000,
      edits: [{ kind: "cut", startMs: 2000, endMs: 4000 }],
    });
    const plan = buildAudioPass1Plan({
      manifest,
      sourcePath: "/tmp/source.mp4",
      sourceHasAudio: true,
      spans: map.spans,
      outputDurationMs: map.outputDurationMs,
      target: resolveLoudnessTarget("reels"),
    });

    expect(plan).not.toBeNull();
    expect(plan!.args).toContain("-filter_complex");
    expect(plan!.args.join(" ")).toContain("atrim");
    expect(plan!.args.join(" ")).toContain("concat=n=2:v=0:a=1");
    expect(plan!.args.join(" ")).toContain("loudnorm=I=-15.0:tp=-1.0:LRA=7.0:print_format=json");
  });
});

describe("measureAudioLoudnormPass1 (FFmpeg Integration)", () => {
  it("measures synthetic audio file and returns accurate LoudnormStats", async () => {
    const scratch = await mkdtemp(join(tmpdir(), "render-loudnorm-"));
    try {
      const wavPath = join(scratch, "test.wav");
      await run("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-af",
        "volume=-20dB",
        "-c:a",
        "pcm_s16le",
        wavPath,
      ]);

      const manifest = makeManifest();
      const plan = buildAudioPass1Plan({
        manifest,
        sourcePath: wavPath,
        sourceHasAudio: true,
        spans: [{ kind: "retained", sourceStart: 0, sourceEnd: 2000, outputStart: 0, outputEnd: 2000, factor: 1 }],
        outputDurationMs: 2000,
        target: resolveLoudnessTarget("youtube-shorts"),
      });

      expect(plan).not.toBeNull();
      const stats = await measureAudioLoudnormPass1({ plan: plan! });

      expect(stats).not.toBeNull();
      expect(stats!.inputI).toBeLessThan(-10);
      expect(Number.isFinite(stats!.targetOffset)).toBe(true);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
