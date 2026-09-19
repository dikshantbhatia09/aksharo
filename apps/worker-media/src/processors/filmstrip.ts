import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface FilmstripMetadata {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly totalFrames: number;
  readonly intervalSec: number;
  readonly spriteUrl?: string;
}

export interface FilmstripOptions {
  readonly ffmpegPath?: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly durationSec: number;
  readonly intervalSec?: number;
  readonly frameHeight?: number;
  readonly frameWidth?: number;
}

/**
 * Generates a single horizontal filmstrip sprite (WebP) sampled at regular intervals.
 * Default: 0.5s intervals, 27x48px (9:16 ratio) per frame tiled horizontally (Nx1).
 */
export async function generateFilmstripSprite(options: FilmstripOptions): Promise<FilmstripMetadata> {
  const ffmpeg = options.ffmpegPath || "ffmpeg";
  const interval = options.intervalSec ?? 0.5;
  const frameHeight = options.frameHeight ?? 48;
  const frameWidth = options.frameWidth ?? 27;

  const totalFrames = Math.max(1, Math.floor(options.durationSec / interval));
  const fps = 1 / interval;

  // FFmpeg video filter: sample at fps, scale & crop to 27x48, tile horizontally as totalFrames x 1
  const filterString = `fps=${fps},scale=${frameWidth}:${frameHeight}:force_original_aspect_ratio=increase,crop=${frameWidth}:${frameHeight},tile=${totalFrames}x1`;

  const args = [
    "-y",
    "-i",
    options.inputPath,
    "-vf",
    filterString,
    "-vframes",
    "1",
    "-c:v",
    "libwebp",
    "-quality",
    "75",
    options.outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: "ignore" });
    proc.on("close", (code) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- internal temp path
      if (code === 0 && existsSync(options.outputPath)) {
        resolve();
      } else {
        // Fallback or error
        reject(new Error(`FFmpeg filmstrip generation exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });

  return {
    frameWidth,
    frameHeight,
    totalFrames,
    intervalSec: interval,
  };
}
