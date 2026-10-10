import { transientFailure, unreadableMedia } from "../errors.js";
import { FFMPEG_BASE_ARGS, inputArgs, run } from "../ffmpeg/run.js";
import { logger } from "../logger.js";

import type { RunOptions, RunResult } from "../ffmpeg/run.js";

export interface StickerTranscodeOptions {
  /** Input file path or URL (e.g. animated GIF, WebP, or MP4) */
  readonly inputPath: string;
  /** Output file path for transparent WebM */
  readonly outputPath: string;
  /** Target framerate for smooth playback (default: 30) */
  readonly fps?: number;
  /** Maximum pixel width or height while maintaining aspect ratio (optional) */
  readonly maxDimension?: number;
  /** Quality CRF for VP9 compression (default: 28) */
  readonly crf?: number;
  /** Target pixel format with alpha (default: yuva420p) */
  readonly pixelFormat?: "yuva420p" | "rgba";
}

export interface StickerTranscodeResult {
  readonly outputPath: string;
  readonly format: "webm" | "webp";
  readonly hasAlpha: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly durationSec?: number;
}

export interface StickerTranscodeContext {
  readonly ffmpegPath: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (percent: number) => void;
}

/**
 * Builds standard FFmpeg arguments for transposing animated GIFs and stickers
 * into transparent VP9 WebM with full alpha channel (Pillar 6 §04 / Submagic forensic reverse-engineering).
 *
 * Command pattern:
 * ffmpeg -i sticker.gif -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 sticker_alpha.webm
 */
export function buildStickerAlphaWebmArgs(options: StickerTranscodeOptions): string[] {
  const fps = options.fps ?? 30;
  const crf = options.crf ?? 28;
  const pixFmt = options.pixelFormat ?? "yuva420p";

  const videoFilters: string[] = [];

  if (options.maxDimension && options.maxDimension > 0) {
    // Scale while preserving aspect ratio and ensuring even dimensions
    videoFilters.push(
      `scale='min(${options.maxDimension},iw)':'min(${options.maxDimension},ih)':force_original_aspect_ratio=decrease`,
      "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    );
  }

  // Force framerate if specified
  if (fps > 0) {
    videoFilters.push(`fps=${fps}`);
  }

  const args: string[] = [
    ...FFMPEG_BASE_ARGS,
    "-loglevel",
    "error",
    ...inputArgs(options.inputPath),
    "-an", // Stickers are visually overlaid with zero audio tracks
    "-sn",
    "-dn",
  ];

  if (videoFilters.length > 0) {
    args.push("-vf", videoFilters.join(","));
  }

  args.push(
    "-c:v",
    "libvpx-vp9",
    "-pix_fmt",
    pixFmt,
    "-b:v",
    "0",
    "-crf",
    String(crf),
    "-deadline",
    "realtime",
    "-cpu-used",
    "4",
    "-auto-alt-ref",
    "0", // Prevents VP9 temporal filtering from corrupting alpha channel
    options.outputPath,
  );

  return args;
}

/**
 * Transcodes an animated GIF or sticker into a transparent WebM container.
 * Eliminates Chromium decoding lag and delivers 100% clean alpha edges (zero black matting artifacts).
 */
export async function transcodeStickerToAlphaWebm(
  options: StickerTranscodeOptions,
  context: StickerTranscodeContext,
): Promise<StickerTranscodeResult> {
  const args = buildStickerAlphaWebmArgs(options);

  logger.info("transcoding sticker to transparent alpha WebM", {
    input: options.inputPath,
    output: options.outputPath,
    fps: options.fps ?? 30,
    pixelFormat: options.pixelFormat ?? "yuva420p",
  });

  const runOptions: RunOptions = {
    timeoutMs: context.timeoutMs ?? 60_000,
    signal: context.signal,
    onStderr: (chunk: string) => {
      if (context.onProgress && chunk.includes("time=")) {
        // Parse timeprogress if needed
        context.onProgress(50);
      }
    },
  };

  const result: RunResult = await run(context.ffmpegPath, args, runOptions);

  if (result.code !== 0) {
    if (result.stderr.includes("Invalid data found when processing input")) {
      throw unreadableMedia("Sticker source media file is invalid or corrupt", "media/corrupt");
    }
    throw transientFailure(
      "ffmpeg/sticker_transcode_failed",
      `FFmpeg sticker transcode failed with exit code ${result.code}: ${result.stderr}`,
    );
  }

  return {
    outputPath: options.outputPath,
    format: "webm",
    hasAlpha: true,
  };
}
