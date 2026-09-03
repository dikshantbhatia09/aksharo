import { describe, expect, it } from "vitest";

import {
  ffprobePathFromFfmpegPath,
  parseFfprobeOutput,
  probeViaFfprobe,
  type ExecFile,
} from "./probe.js";

const SAMPLE_FFPROBE_JSON = JSON.stringify({
  format: { duration: "12.345000" },
  streams: [
    {
      codec_type: "video",
      width: 1080,
      height: 1920,
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
      color_transfer: "bt709",
      color_primaries: "bt709",
    },
    { codec_type: "audio", channels: 2, sample_rate: "48000" },
  ],
});

describe("ffprobePathFromFfmpegPath", () => {
  it("resolves the sibling ffprobe binary on win32", () => {
    expect(ffprobePathFromFfmpegPath("C:\\models\\bin\\ffmpeg.exe", "win32")).toBe(
      "C:\\models\\bin\\ffprobe.exe",
    );
  });

  it("resolves the sibling ffprobe binary on darwin/linux (no extension)", () => {
    expect(ffprobePathFromFfmpegPath("/models/bin/ffmpeg", "darwin")).toBe("/models/bin/ffprobe");
  });
});

describe("parseFfprobeOutput", () => {
  it("parses duration/fps/dimensions/audio layout from a real ffprobe shape", () => {
    const result = parseFfprobeOutput(SAMPLE_FFPROBE_JSON);
    expect(result.durationMs).toBe(12_345);
    expect(result.fps).toBe(30);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.audioChannels).toBe(2);
    expect(result.audioSampleRateHz).toBe(48_000);
    expect(result.hdr).toBe(false);
  });

  it("flags HDR from a PQ/HLG transfer or BT.2020 primaries", () => {
    const hdr = parseFfprobeOutput(
      JSON.stringify({
        format: { duration: "1" },
        streams: [{ codec_type: "video", color_transfer: "smpte2084" }],
      }),
    );
    expect(hdr.hdr).toBe(true);
  });

  it("returns nulls for a file with no video/audio streams, never throwing", () => {
    const result = parseFfprobeOutput(JSON.stringify({ format: {}, streams: [] }));
    expect(result.durationMs).toBeNull();
    expect(result.fps).toBeNull();
    expect(result.width).toBeNull();
    expect(result.hdr).toBe(false);
  });
});

describe("probeViaFfprobe", () => {
  it("invokes ffprobe with the expected flags and parses its stdout", async () => {
    let capturedArgs: readonly string[] = [];
    const execFile: ExecFile = async (file, args) => {
      expect(file).toBe("/models/bin/ffprobe");
      capturedArgs = args;
      return { stdout: SAMPLE_FFPROBE_JSON, stderr: "" };
    };

    const result = await probeViaFfprobe("/tmp/clip.mp4", "/models/bin/ffprobe", execFile);

    expect(capturedArgs).toContain("/tmp/clip.mp4");
    expect(capturedArgs).toContain("-show_streams");
    expect(result.width).toBe(1080);
  });
});
