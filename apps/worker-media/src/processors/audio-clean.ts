import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export interface AudioCleanOptions {
  readonly ffmpegPath?: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly level?: "low" | "balanced" | "aggressive";
  /**
   * When true, applies the post-enhancement vocal master filter in FFmpeg
   * (Pillar 5, Functionality 01): high-pass filter at 80 Hz to eliminate sub-bass rumble
   * and broadcast vocal compression:
   * `highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=50`.
   */
  readonly vocalMaster?: boolean;
  /** Custom audio filter chain override if specified. */
  readonly customFilter?: string;
  /** Audio sample rate (default: 48000 for studio master, or 16000). */
  readonly sampleRate?: number;
}

export interface CleanAndUploadAudioOptions extends AudioCleanOptions {
  readonly s3Store?: {
    putFile(input: {
      readonly key: string;
      readonly file: string;
      readonly contentType: string;
      readonly tags?: Readonly<Record<string, string>>;
    }): Promise<number>;
    presignGet?(key: string, expiresInSeconds: number): Promise<string>;
  };
  readonly s3Key?: string;
  readonly mediaId?: string;
  readonly attemptId?: string;
  readonly callbacks?: {
    patchMedia(
      mediaId: string,
      attemptId: string | undefined,
      patch: Readonly<Record<string, unknown>>,
    ): Promise<void>;
  };
}

export interface CleanAndUploadAudioResult {
  readonly localPath: string;
  readonly audioCleanUri?: string;
  readonly s3Key?: string;
  readonly bytesUploaded?: number;
}

/**
 * Standard vocal master filter chain: 80 Hz high-pass + broadcast vocal compressor.
 */
export const VOCAL_MASTER_FILTER =
  "highpass=f=80,acompressor=threshold=-18dB:ratio=3:attack=5:release=50";

/**
 * Builds the FFmpeg audio filter argument string.
 */
export function buildAudioCleanFilter(options: {
  level?: "low" | "balanced" | "aggressive";
  vocalMaster?: boolean;
  customFilter?: string;
}): string {
  if (options.customFilter) {
    return options.customFilter;
  }

  if (options.vocalMaster) {
    return VOCAL_MASTER_FILTER;
  }

  const level = options.level ?? "balanced";
  let noiseFloor = -25;
  if (level === "low") noiseFloor = -18;
  if (level === "aggressive") noiseFloor = -35;

  return `highpass=f=80,lowpass=f=8500,afftdn=nf=${noiseFloor}:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11`;
}

/**
 * Cleans audio via FFmpeg noise reduction, voice isolation filtering, and vocal mastering.
 * Applies highpass, dynamic vocal compression, and loudness normalization.
 */
export async function cleanAudio(options: AudioCleanOptions): Promise<void> {
  const ffmpeg = options.ffmpegPath || "ffmpeg";
  const sampleRate = options.sampleRate ?? 48_000;
  const audioFilter = buildAudioCleanFilter(options);

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
    String(sampleRate),
    "-ac",
    "1",
    options.outputPath,
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: "ignore" });
    proc.on("close", (code) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- internal temp path
      if (code === 0 && existsSync(options.outputPath)) {
        resolve();
      } else {
        reject(new Error(`FFmpeg audio clean exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}

/**
 * Cleans audio with the vocal master pipeline, uploads `audioCleanUri` to S3,
 * and updates `MediaAsset` via callback write-back.
 */
export async function cleanAndUploadAudio(
  options: CleanAndUploadAudioOptions,
): Promise<CleanAndUploadAudioResult> {
  await cleanAudio(options);

  let bytesUploaded: number | undefined;
  let audioCleanUri: string | undefined;

  if (options.s3Store && options.s3Key) {
    bytesUploaded = await options.s3Store.putFile({
      key: options.s3Key,
      file: options.outputPath,
      contentType: "audio/wav",
    });
    audioCleanUri = options.s3Key;

    if (options.callbacks && options.mediaId) {
      await options.callbacks.patchMedia(options.mediaId, options.attemptId, {
        audioCleanUri,
        audioCleanKey: options.s3Key,
      });
    }
  }

  return {
    localPath: options.outputPath,
    audioCleanUri,
    s3Key: options.s3Key,
    bytesUploaded,
  };
}
