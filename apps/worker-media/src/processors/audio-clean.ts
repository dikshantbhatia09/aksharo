import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface AudioCleanOptions {
  readonly ffmpegPath?: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly level?: "low" | "balanced" | "aggressive";
}

/**
 * Cleans audio via FFmpeg noise reduction and voice isolation filtering.
 * Applies highpass, lowpass, dynamic spectral gating (afftdn), and normalization.
 */
export async function cleanAudio(options: AudioCleanOptions): Promise<void> {
  const ffmpeg = options.ffmpegPath || "ffmpeg";
  const level = options.level ?? "balanced";

  // Calibrate noise reduction floor (dB)
  let noiseFloor = -25;
  if (level === "low") noiseFloor = -18;
  if (level === "aggressive") noiseFloor = -35;

  const audioFilter = `highpass=f=80,lowpass=f=8500,afftdn=nf=${noiseFloor}:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11`;

  const args = [
    "-y",
    "-i",
    options.inputPath,
    "-vn",
    "-af",
    audioFilter,
    "-c:a",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    options.outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: "ignore" });
    proc.on("close", (code) => {
      if (code === 0 && existsSync(options.outputPath)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg audio clean exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
