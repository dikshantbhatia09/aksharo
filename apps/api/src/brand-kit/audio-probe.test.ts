import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { probeAudio } from "./audio-probe.js";

/**
 * The header readers against real files: ffmpeg writes each format the way
 * people's tools do (a LAME MP3 with its Info frame, a plain CBR MP3 without
 * one, PCM and float WAV, an AAC M4A with its index up front and at the end),
 * and each must come back as what it is, about as long as it is.
 */
const CAN_RUN = spawnSync("ffmpeg", ["-version"], { stdio: "pipe", timeout: 20_000 }).status === 0;
if (!CAN_RUN) console.warn("[audio-probe.test] ffmpeg is not on PATH; the file tests are skipped.");

let dir = "";

function make(name: string, args: readonly string[]): Uint8Array {
  const path = join(dir, name);
  const result = spawnSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args, path],
    { stdio: "pipe", encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) throw new Error(`could not make ${name}:\n${result.stderr}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file this test just wrote in its own temporary directory
  return new Uint8Array(readFileSync(path));
}

const TONE = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=7.5"];

describe.skipIf(!CAN_RUN)("probeAudio on real files", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "montaj-audio-probe-"));
  });
  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("reads a LAME MP3's length from its Info frame", () => {
    const facts = probeAudio(make("vbr.mp3", [...TONE, "-c:a", "libmp3lame", "-q:a", "4"]));
    expect(facts?.format).toBe("mp3");
    expect(Math.abs((facts?.durationMs ?? 0) - 7_500)).toBeLessThan(120);
  });

  it("reads a constant-rate MP3 with no Info frame, and one behind an ID3 tag", () => {
    const bare = probeAudio(
      make("cbr.mp3", [...TONE, "-c:a", "libmp3lame", "-b:a", "128k", "-write_xing", "0"]),
    );
    expect(bare?.format).toBe("mp3");
    expect(Math.abs((bare?.durationMs ?? 0) - 7_500)).toBeLessThan(150);

    const tagged = probeAudio(
      make("tagged.mp3", [
        ...TONE,
        "-c:a",
        "libmp3lame",
        "-b:a",
        "96k",
        "-metadata",
        "title=Morning theme",
        "-id3v2_version",
        "3",
      ]),
    );
    expect(tagged?.format).toBe("mp3");
    expect(Math.abs((tagged?.durationMs ?? 0) - 7_500)).toBeLessThan(150);
  });

  it("reads a WAV's length, PCM or float, mono or stereo", () => {
    const pcm = probeAudio(make("pcm.wav", [...TONE, "-c:a", "pcm_s16le", "-ac", "2"]));
    expect(pcm).toEqual({ format: "wav", durationMs: 7_500 });
    const float = probeAudio(make("float.wav", [...TONE, "-c:a", "pcm_f32le"]));
    expect(float).toEqual({ format: "wav", durationMs: 7_500 });
  });

  it("reads an M4A's length, its index up front or at the end", () => {
    const front = probeAudio(
      make("front.m4a", [...TONE, "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart"]),
    );
    expect(front?.format).toBe("m4a");
    expect(Math.abs((front?.durationMs ?? 0) - 7_500)).toBeLessThan(100);
    const end = probeAudio(make("end.m4a", [...TONE, "-c:a", "aac", "-b:a", "96k"]));
    expect(end?.format).toBe("m4a");
    expect(Math.abs((end?.durationMs ?? 0) - 7_500)).toBeLessThan(100);
  });

  it("is nothing for a video's MP4 with no sound, or an image", () => {
    const silentVideo = make("video.mp4", [
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=10:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
    ]);
    expect(probeAudio(silentVideo)).toBeUndefined();
    const image = make("image.png", [
      "-f",
      "lavfi",
      "-i",
      "color=c=red:size=16x16",
      "-frames:v",
      "1",
    ]);
    expect(probeAudio(image)).toBeUndefined();
  });
});

describe("probeAudio on what is not audio", () => {
  it("is nothing for random or empty bytes, or a RIFF that is not a WAVE", () => {
    expect(probeAudio(new Uint8Array())).toBeUndefined();
    const noise = Uint8Array.from({ length: 4_096 }, (_, index) => (index * 131) % 251);
    expect(probeAudio(noise)).toBeUndefined();
    const avi = new TextEncoder().encode(`RIFF\u0000\u0000\u0000\u0000AVI LIST${" ".repeat(64)}`);
    expect(probeAudio(avi)).toBeUndefined();
  });

  it("does not take one stray frame sync for an MP3", () => {
    const bytes = new Uint8Array(2_048);
    // A valid-looking Layer III header, followed by nothing like a second one.
    bytes.set([0xff, 0xfb, 0x90, 0x64], 100);
    expect(probeAudio(bytes)).toBeUndefined();
  });
});
