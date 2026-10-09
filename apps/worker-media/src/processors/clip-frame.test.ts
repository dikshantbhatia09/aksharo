import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  ASPECT_TARGET_RESOLUTIONS,
  ASPECT_TYPOGRAPHY_BASE_PX,
  CLIP_ASPECTS,
  buildMultiAspectBatchFiltergraph,
  clipFrame,
  computeNormalizedAspectCrop,
  recomposeMultiAspectFrames,
  type ClipAspect,
} from "./clip-frame.js";

function ffmpegAvailable(): boolean {
  return (
    spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 }).status === 0
  );
}

const CAN_RUN_FFMPEG = ffmpegAvailable();

function probeDimensions(file: string): { width: number; height: number } {
  const probe = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      file,
    ],
    { stdio: "pipe", encoding: "utf8", timeout: 30_000 },
  );
  const [width, height] = probe.stdout.trim().split(",").map(Number);
  return { width: width ?? 0, height: height ?? 0 };
}

describe("Multi-Aspect Ratio Engine (9:16, 1:1, 4:5, 16:9) — clip-frame.test.ts (Pillar 3 §06)", () => {
  const ASPECTS: readonly ClipAspect[] = ["9:16", "1:1", "4:5", "16:9"];

  it("verifies crop bounds for all 4 aspect ratios on a 16:9 landscape source (1920×1080)", () => {
    const source = { width: 1920, height: 1080 };

    // 9:16 crop on 1920x1080 -> 608x1080 centered at x=656
    const f9x16 = clipFrame(source, { aspect: "9:16", centerX: 0.5, centerY: 0.5 });
    expect(f9x16?.crop).toEqual({ width: 608, height: 1080, x: 656, y: 0 });

    // 1:1 crop on 1920x1080 -> 1080x1080 centered at x=420
    const f1x1 = clipFrame(source, { aspect: "1:1", centerX: 0.5, centerY: 0.5 });
    expect(f1x1?.crop).toEqual({ width: 1080, height: 1080, x: 420, y: 0 });

    // 4:5 crop on 1920x1080 -> 864x1080 centered at x=528
    const f4x5 = clipFrame(source, { aspect: "4:5", centerX: 0.5, centerY: 0.5 });
    expect(f4x5?.crop).toEqual({ width: 864, height: 1080, x: 528, y: 0 });

    // 16:9 crop on 1920x1080 -> full frame 1920x1080 at x=0, y=0
    const f16x9 = clipFrame(source, { aspect: "16:9", centerX: 0.5, centerY: 0.5 });
    expect(f16x9?.crop).toEqual({ width: 1920, height: 1080, x: 0, y: 0 });

    // Off-center speaker (centerX=0.92, near right edge) clamps within frame boundaries
    for (const aspect of ASPECTS) {
      const crop = computeNormalizedAspectCrop(source, aspect, { centerX: 0.92, centerY: 0.15 });
      expect(crop).not.toBeNull();
      if (crop === null) continue;
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
      expect(crop.width % 2).toBe(0);
      expect(crop.height % 2).toBe(0);
    }
  });

  it("verifies crop bounds for all 4 aspect ratios on a 9:16 portrait source (1080×1920)", () => {
    const source = { width: 1080, height: 1920 };

    // 9:16 on 1080x1920 -> full frame 1080x1920
    const f9x16 = clipFrame(source, { aspect: "9:16", centerX: 0.5, centerY: 0.5 });
    expect(f9x16?.crop).toEqual({ width: 1080, height: 1920, x: 0, y: 0 });

    // 1:1 on 1080x1920 -> 1080x1080 centered vertically at y=420
    const f1x1 = clipFrame(source, { aspect: "1:1", centerX: 0.5, centerY: 0.5 });
    expect(f1x1?.crop).toEqual({ width: 1080, height: 1080, x: 0, y: 420 });

    // 4:5 on 1080x1920 -> 1080x1350 centered vertically at y=284
    const f4x5 = clipFrame(source, { aspect: "4:5", centerX: 0.5, centerY: 0.5 });
    expect(f4x5?.crop).toEqual({ width: 1080, height: 1350, x: 0, y: 284 });

    // 16:9 on 1080x1920 -> 1080x608 centered vertically at y=656
    const f16x9 = clipFrame(source, { aspect: "16:9", centerX: 0.5, centerY: 0.5 });
    expect(f16x9?.crop).toEqual({ width: 1080, height: 608, x: 0, y: 656 });

    // Upper-third face (centerY=0.1) clamps vertically to top of portrait frame
    for (const aspect of ASPECTS) {
      const crop = computeNormalizedAspectCrop(source, aspect, { centerX: 0.5, centerY: 0.05 });
      expect(crop).not.toBeNull();
      if (crop === null) continue;
      expect(crop.x).toBe(0);
      expect(crop.y).toBe(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(source.width);
      expect(crop.y + crop.height).toBeLessThanOrEqual(source.height);
    }
  });

  it("verifies crop bounds for all 4 aspect ratios on a 1:1 square source (1080×1080)", () => {
    const source = { width: 1080, height: 1080 };

    // 9:16 on 1080x1080 -> 608x1080 centered horizontally at x=236
    const f9x16 = clipFrame(source, { aspect: "9:16", centerX: 0.5, centerY: 0.5 });
    expect(f9x16?.crop).toEqual({ width: 608, height: 1080, x: 236, y: 0 });

    // 1:1 on 1080x1080 -> full frame 1080x1080
    const f1x1 = clipFrame(source, { aspect: "1:1", centerX: 0.5, centerY: 0.5 });
    expect(f1x1?.crop).toEqual({ width: 1080, height: 1080, x: 0, y: 0 });

    // 4:5 on 1080x1080 -> 864x1080 centered horizontally at x=108
    const f4x5 = clipFrame(source, { aspect: "4:5", centerX: 0.5, centerY: 0.5 });
    expect(f4x5?.crop).toEqual({ width: 864, height: 1080, x: 108, y: 0 });

    // 16:9 on 1080x1080 -> 1080x608 centered vertically at y=236
    const f16x9 = clipFrame(source, { aspect: "16:9", centerX: 0.5, centerY: 0.5 });
    expect(f16x9?.crop).toEqual({ width: 1080, height: 608, x: 0, y: 236 });
  });

  it("meets the <= 10ms SLA for multi-aspect re-composition across all 4 aspect ratios", () => {
    const start = performance.now();
    const compositions = recomposeMultiAspectFrames(
      { width: 3840, height: 2160 },
      ["9:16", "1:1", "4:5", "16:9"],
      { centerX: 0.38, centerY: 0.42, resolution: "1080p" },
    );
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(10);
    expect(compositions).toHaveLength(4);
    expect(compositions.map((c) => c.aspect)).toEqual(["9:16", "1:1", "4:5", "16:9"]);
    expect(compositions.map((c) => c.captionFontSizePx)).toEqual([
      ASPECT_TYPOGRAPHY_BASE_PX["9:16"], // 54
      ASPECT_TYPOGRAPHY_BASE_PX["1:1"], // 42
      ASPECT_TYPOGRAPHY_BASE_PX["4:5"], // 48
      ASPECT_TYPOGRAPHY_BASE_PX["16:9"], // 44
    ]);
  });

  it.skipIf(!CAN_RUN_FFMPEG)(
    "renders an end-to-end simultaneous multi-format batch export producing valid MP4s for all selected aspects",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "montaj-multi-aspect-"));
      try {
        const sourceMp4 = join(workDir, "source_16x9.mp4");
        // Generate a 1-second 640x360 landscape source video
        const gen = spawnSync(
          "ffmpeg",
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=640x360:rate=24:duration=1",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=1",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            sourceMp4,
          ],
          { stdio: "pipe", encoding: "utf8", timeout: 60_000 },
        );
        expect(gen.status).toBe(0);

        const plan = buildMultiAspectBatchFiltergraph(
          { width: 640, height: 360 },
          [
            { aspect: "9:16", resolution: "720p", centerX: 0.5, centerY: 0.5 },
            { aspect: "1:1", resolution: "720p", centerX: 0.5, centerY: 0.5 },
            { aspect: "4:5", resolution: "720p", centerX: 0.5, centerY: 0.5 },
            { aspect: "16:9", resolution: "720p", centerX: 0.5, centerY: 0.5 },
          ],
        );
        expect(plan).not.toBeNull();
        if (plan === null) return;

        expect(plan.streams).toHaveLength(4);
        expect(plan.filterComplex).toContain("split=4");

        const outFiles: Record<ClipAspect, string> = {
          "9:16": join(workDir, "clip_reels_9x16.mp4"),
          "1:1": join(workDir, "clip_linkedin_1x1.mp4"),
          "4:5": join(workDir, "clip_feed_4x5.mp4"),
          "16:9": join(workDir, "clip_youtube_16x9.mp4"),
        };

        const ffmpegArgs: string[] = [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          sourceMp4,
          "-filter_complex",
          plan.filterComplex,
        ];

        for (const stream of plan.streams) {
          // eslint-disable-next-line security/detect-object-injection -- closed enum key
          const outFile = outFiles[stream.aspect];
          ffmpegArgs.push(
            "-map",
            `[${stream.outputLabel}]`,
            "-map",
            "0:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            outFile,
          );
        }

        const batchRender = spawnSync("ffmpeg", ffmpegArgs, {
          stdio: "pipe",
          encoding: "utf8",
          timeout: 60_000,
        });
        expect(batchRender.status).toBe(0);

        for (const aspect of Object.keys(CLIP_ASPECTS) as ClipAspect[]) {
          // eslint-disable-next-line security/detect-object-injection -- closed enum key
          const file = outFiles[aspect];
          // eslint-disable-next-line security/detect-object-injection -- closed enum key
          const expectedDim = ASPECT_TARGET_RESOLUTIONS[aspect]["720p"];
          const info = await stat(file);
          expect(info.size).toBeGreaterThan(1024);
          expect(probeDimensions(file)).toEqual(expectedDim);
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  );
});
