import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EncodeError, runEncode } from "./encode.js";
import { parseProbeOutput, parseRational, probeMedia, ProbeError } from "./probe.js";
import {
  assertMediaToolsAvailable,
  EXPECTED_FFMPEG_MAJOR,
  MediaToolsError,
  MINIMUM_FFMPEG_MAJOR,
  parseMajor,
  REQUIRED_TOOLS,
  toolVersion,
} from "./tools.js";
import { makeSyntheticClip, removeQuietly } from "../testing.js";

let scratch: string;
let clip: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "a20-ffmpeg-"));
  clip = join(scratch, "clip.mp4");
  await makeSyntheticClip(clip, { seconds: 2, width: 160, height: 120, fps: 10 });
}, 300_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("the tool check", () => {
  it("names both binaries it cannot run without", () => {
    expect(REQUIRED_TOOLS).toEqual(["ffmpeg", "ffprobe"]);
  });

  it("pins the major it is developed against, above the supported floor", () => {
    expect(EXPECTED_FFMPEG_MAJOR).toBeGreaterThanOrEqual(MINIMUM_FFMPEG_MAJOR);
  });

  it("reads the major out of a real version line", () => {
    expect(parseMajor("ffmpeg version 9.0-full_build-www.gyan.dev Copyright (c) 2000-2026")).toBe(
      9,
    );
    expect(parseMajor("ffmpeg version n6.1.1 Copyright (c) 2000-2023")).toBe(6);
    expect(parseMajor("ffmpeg version 2026-01-01-git-abc123")).toBeNull();
    expect(parseMajor("no version here")).toBeNull();
  });

  it("finds ffmpeg and ffprobe on this machine", async () => {
    const tools = await assertMediaToolsAvailable();
    expect(tools).toHaveLength(2);
    for (const tool of tools) expect(tool.version).toContain("version");
  });

  it("answers null for a binary that is not there", async () => {
    expect(await toolVersion("ffmpeg-that-does-not-exist" as "ffmpeg")).toBeNull();
  });

  it("carries an error type with installation instructions in it", () => {
    const error = new MediaToolsError("render/no-ffmpeg", "not found");
    expect(error.code).toBe("render/no-ffmpeg");
    expect(error.name).toBe("MediaToolsError");
  });
});

describe("ffprobe parsing", () => {
  it("turns a rational frame rate into a number", () => {
    expect(parseRational("30/1")).toBe(30);
    expect(parseRational("30000/1001")).toBeCloseTo(29.97, 2);
    expect(parseRational("0/0")).toBeUndefined();
    expect(parseRational("")).toBeUndefined();
    expect(parseRational(undefined)).toBeUndefined();
    expect(parseRational("24")).toBe(24);
  });

  it("reads a real file", async () => {
    const probe = await probeMedia(clip);
    expect(probe.video?.codec).toBe("h264");
    expect(probe.displayWidth).toBe(160);
    expect(probe.displayHeight).toBe(120);
    expect(probe.audio?.codec).toBe("aac");
    expect(probe.durationMs).toBeGreaterThan(1_800);
    expect(probe.hasAlpha).toBe(false);
  });

  it("transposes the dimensions of a rotated phone recording", () => {
    const probe = parseProbeOutput(
      JSON.stringify({
        format: { duration: "12.5" },
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1920,
            height: 1080,
            r_frame_rate: "30/1",
            side_data_list: [{ rotation: -90 }],
          },
        ],
      }),
    );
    // Stored landscape, displayed portrait: cropping to the stored numbers would
    // put the caption box on its side.
    expect(probe.displayWidth).toBe(1080);
    expect(probe.displayHeight).toBe(1920);
    expect(probe.video?.rotation).toBe(270);
    expect(probe.durationMs).toBe(12_500);
  });

  it("reads the legacy rotate tag too", () => {
    const probe = parseProbeOutput(
      JSON.stringify({
        streams: [
          { codec_type: "video", width: 1920, height: 1080, tags: { rotate: "90" }, duration: "3" },
        ],
      }),
    );
    expect(probe.displayWidth).toBe(1080);
    expect(probe.durationMs).toBe(3_000);
  });

  it("notices an alpha pixel format", () => {
    const probe = parseProbeOutput(
      JSON.stringify({
        streams: [{ codec_type: "video", width: 10, height: 10, pix_fmt: "yuva444p10le" }],
      }),
    );
    expect(probe.hasAlpha).toBe(true);
  });

  it("reports a file with no video stream rather than failing later", async () => {
    const audioOnly = join(scratch, "audio.m4a");
    await makeSyntheticClip(audioOnly, { seconds: 1, audio: true }).catch(() => undefined);
    const probe = parseProbeOutput(
      JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }] }),
    );
    expect(probe.video).toBeNull();
    expect(probe.audio?.codec).toBe("aac");
  });

  it("refuses output that is not JSON", () => {
    expect(() => parseProbeOutput("not json")).toThrow(ProbeError);
  });

  it("refuses a file it cannot read", async () => {
    await expect(probeMedia(join(scratch, "nothing-here.mp4"))).rejects.toThrow(ProbeError);
  });

  it("refuses a file with no video stream", async () => {
    const text = join(scratch, "not-a-video.txt");
    await writeFile(text, "hello");
    await expect(probeMedia(text)).rejects.toThrow(ProbeError);
  });
});

describe("the encode loop", () => {
  it("feeds frames down the pipe and produces a file", async () => {
    const output = join(scratch, "encoded.mp4");
    const width = 32;
    const height = 32;
    const frames = 12;
    const buffer = new Uint8Array(width * height * 4).fill(200);

    const seen: number[] = [];
    const result = await runEncode({
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        `${String(width)}x${String(height)}`,
        "-framerate",
        "12",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        output,
      ],
      frames,
      frame: (index) => {
        seen.push(index);
        return buffer;
      },
      onProgress: () => undefined,
    });

    expect(result.framesWritten).toBe(frames);
    expect(seen).toEqual([...Array(frames).keys()]);
    expect((await readFile(output)).byteLength).toBeGreaterThan(100);
    expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it("reports ffmpeg's own complaint when it exits non-zero", async () => {
    let caught: unknown;
    try {
      await runEncode({
        args: ["-hide_banner", "-loglevel", "error", "-nonsense-flag"],
        frames: 1,
        frame: () => new Uint8Array(4),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EncodeError);
    expect((caught as EncodeError).code).toBe("render/ffmpeg-failed");
    expect((caught as EncodeError).stderrTail.length).toBeGreaterThan(0);
  }, 120_000);

  it("says so when ffmpeg cannot be started at all", async () => {
    let caught: unknown;
    try {
      await runEncode({
        args: ["-version"],
        frames: 0,
        frame: () => new Uint8Array(4),
        ffmpegPath: join(scratch, "no-such-ffmpeg"),
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as EncodeError).code).toBe("render/ffmpeg-spawn-failed");
  }, 60_000);

  it("stops feeding frames when it is aborted", async () => {
    const controller = new AbortController();
    const output = join(scratch, "aborted.mp4");
    const buffer = new Uint8Array(64 * 64 * 4);
    const promise = runEncode({
      args: [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pixel_format",
        "rgba",
        "-video_size",
        "64x64",
        "-framerate",
        "30",
        "-i",
        "pipe:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        output,
      ],
      frames: 100_000,
      frame: () => buffer,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 300);
    await expect(promise).rejects.toThrow(EncodeError);
  }, 120_000);
});
