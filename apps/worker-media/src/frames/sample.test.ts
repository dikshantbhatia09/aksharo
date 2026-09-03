import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_FRAME_WIDTH, SAMPLE_HZ, sampleFrames, sampleFramesArgs } from "./sample.js";

const execFileAsync = promisify(execFile);

/** The argument after `flag`, so a test reads like the command line does. */
function valueOf(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe("sampleFramesArgs", () => {
  it("decodes forward with the fps filter rather than seeking per frame", () => {
    const args = sampleFramesArgs({
      source: "https://example.test/proxy540.mp4",
      outPattern: "/tmp/out/frame-%05d.jpg",
      hz: 10,
      maxWidth: 320,
    });
    expect(args).not.toContain("-ss");
    expect(valueOf(args, "-map")).toBe("0:v:0");
    expect(valueOf(args, "-vf")).toBe("fps=10,scale=320:-2:flags=bicubic");
    expect(valueOf(args, "-f")).toBe("image2");
    expect(args.at(-1)).toBe("/tmp/out/frame-%05d.jpg");
  });

  it("defaults match B19b's ruling: 10 Hz, <= 320 px wide", () => {
    expect(SAMPLE_HZ).toBe(10);
    expect(MAX_FRAME_WIDTH).toBe(320);
  });
});

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(ffmpegAvailable())("sampleFrames (real ffmpeg)", () => {
  let workdir: string;

  afterEach(async () => {
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it("writes a downscaled JPEG filmstrip at the requested rate", async () => {
    workdir = await mkdtemp(join(tmpdir(), "montaj-frames-"));
    const source = join(workdir, "source.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=duration=2:size=640x360:rate=25",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      source,
    ]);

    const outDir = join(workdir, "frames");
    const frames = await sampleFrames(
      { binary: "ffmpeg", source, timeoutMs: 30_000 },
      { outDir, hz: 10, maxWidth: 320 },
    );

    expect(frames.length).toBeGreaterThanOrEqual(18);
    expect(frames[0]?.tMs).toBe(0);
    expect(frames[1]?.tMs).toBe(100);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const files = await readdir(outDir);
    expect(files.length).toBe(frames.length);
  }, 30_000);
});
