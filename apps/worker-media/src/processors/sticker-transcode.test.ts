import { describe, expect, it, vi } from "vitest";

import {
  buildStickerAlphaWebmArgs,
  transcodeStickerToAlphaWebm,
} from "./sticker-transcode.js";
import * as runModule from "../ffmpeg/run.js";

describe("sticker-transcode", () => {
  describe("buildStickerAlphaWebmArgs", () => {
    it("generates correct VP9 yuva420p arguments with auto-alt-ref 0", () => {
      const args = buildStickerAlphaWebmArgs({
        inputPath: "inputs/funny.gif",
        outputPath: "outputs/funny.webm",
        fps: 30,
        crf: 28,
        pixelFormat: "yuva420p",
      });

      expect(args).toContain("-c:v");
      expect(args).toContain("libvpx-vp9");
      expect(args).toContain("-pix_fmt");
      expect(args).toContain("yuva420p");
      expect(args).toContain("-auto-alt-ref");
      expect(args).toContain("0");
      expect(args).toContain("-an");
      expect(args.at(-1)).toBe("outputs/funny.webm");
    });

    it("includes scaling filter when maxDimension is set", () => {
      const args = buildStickerAlphaWebmArgs({
        inputPath: "inputs/arrow.gif",
        outputPath: "outputs/arrow.webm",
        maxDimension: 512,
      });

      const vfIndex = args.indexOf("-vf");
      expect(vfIndex).toBeGreaterThan(-1);
      const filterStr = args[vfIndex + 1];
      expect(filterStr).toContain("min(512,iw)");
      expect(filterStr).toContain("pad=ceil(iw/2)*2:ceil(ih/2)*2");
    });
  });

  describe("transcodeStickerToAlphaWebm", () => {
    it("executes ffmpeg successfully and returns webm with alpha", async () => {
      const runSpy = vi.spyOn(runModule, "run").mockResolvedValueOnce({
        code: 0,
        stdout: "",
        stderr: "frame= 30 fps=30 q=0.0 Lsize= 100kB time=00:00:01.00",
      });

      const onProgress = vi.fn();
      const result = await transcodeStickerToAlphaWebm(
        {
          inputPath: "inputs/meme.gif",
          outputPath: "outputs/meme.webm",
        },
        {
          ffmpegPath: "ffmpeg",
          onProgress,
        },
      );

      expect(runSpy).toHaveBeenCalled();
      expect(result.format).toBe("webm");
      expect(result.hasAlpha).toBe(true);
      expect(result.outputPath).toBe("outputs/meme.webm");
    });

    it("throws unreadableMedia error on corrupt input file", async () => {
      vi.spyOn(runModule, "run").mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "Invalid data found when processing input",
      });

      await expect(
        transcodeStickerToAlphaWebm(
          {
            inputPath: "inputs/bad.gif",
            outputPath: "outputs/bad.webm",
          },
          {
            ffmpegPath: "ffmpeg",
          },
        ),
      ).rejects.toThrow(/invalid or corrupt/i);
    });

    it("throws transientFailure error on general ffmpeg failure", async () => {
      vi.spyOn(runModule, "run").mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "Encoder error: bitrate buffer overflow",
      });

      await expect(
        transcodeStickerToAlphaWebm(
          {
            inputPath: "inputs/heavy.gif",
            outputPath: "outputs/heavy.webm",
          },
          {
            ffmpegPath: "ffmpeg",
          },
        ),
      ).rejects.toThrow(/exit code 1/i);
    });
  });
});
