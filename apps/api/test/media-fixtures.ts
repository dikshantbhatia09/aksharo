/**
 * Synthetic media for the pipeline suite, generated with ffmpeg at test time.
 *
 * Fixtures are **built, not committed**. A binary in the repository is a binary
 * nobody can review, it bloats every clone forever, and the one property these
 * fixtures need — "this is a real container a real decoder will accept" — is
 * exactly what generating them with the same ffmpeg the worker uses guarantees.
 * `testsrc` and `sine` are ffmpeg's own generators and need no input file.
 *
 * Everything is cached in one temp directory for the run, so a suite with four
 * cases pays for four encodes once.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Is ffmpeg on PATH? The suite skips loudly rather than failing without it. */
export function isFfmpegAvailable(): boolean {
  const probe = spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 });
  return probe.status === 0;
}

export interface FixtureSet {
  readonly dir: string;
  /** 10 s, 1280×720, 30 fps, H.264 + AAC — the ordinary case. */
  readonly video: string;
  /** 4 s, mono 44.1 kHz MP3 — the audio-only path. */
  readonly audio: string;
  /** 3 s tagged `smpte2084` (PQ) — the tone-mapping path. */
  readonly hdr: string;
  /** Random bytes with an `.mp4` name — the unreadable path. */
  readonly corrupt: string;
  cleanup(): Promise<void>;
}

/** Seconds of the main fixture; the assertions quote it. */
export const VIDEO_DURATION_S = 10;
export const VIDEO_WIDTH = 1280;
export const VIDEO_HEIGHT = 720;
export const VIDEO_FPS = 30;

function ffmpeg(args: readonly string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`fixture generation failed:\n${result.stderr ?? ""}`);
  }
}

export async function buildFixtures(): Promise<FixtureSet> {
  const dir = await mkdtemp(join(tmpdir(), "montaj-media-fixtures-"));

  const video = join(dir, "clip.mp4");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  if (!existsSync(video)) {
    ffmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=${String(VIDEO_WIDTH)}x${String(VIDEO_HEIGHT)}:rate=${String(VIDEO_FPS)}:duration=${String(VIDEO_DURATION_S)}`,
      "-f",
      "lavfi",
      // A tone rather than silence: the loudness pass has to have something to
      // measure, and a waveform of zeros proves nothing about the arithmetic.
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${String(VIDEO_DURATION_S)}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "30",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-shortest",
      "-movflags",
      "+faststart",
      video,
    ]);
  }

  const audio = join(dir, "podcast.mp3");
  ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=330:sample_rate=44100:duration=4",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "96k",
    audio,
  ]);

  const hdr = join(dir, "hdr.mp4");
  ffmpeg([
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=640x360:rate=30:duration=3",
    // The metadata is what makes it HDR to a probe: PQ transfer, BT.2020 gamut.
    // It has to go on the FRAMES (`setparams`) rather than as `-color_trc` output
    // options: with libx264 those are dropped and ffprobe reads back `unknown`,
    // which is a fixture that quietly proves nothing.
    "-vf",
    "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    hdr,
  ]);

  const corrupt = join(dir, "broken.mp4");
  // Not a truncated MP4 — random bytes, so there is no moov atom to find and
  // ffprobe's answer is unambiguous.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (workspace/fixture/temp dirs) -- reviewed for the same follow-up
  await writeFile(corrupt, randomBytes(64 * 1024));

  return {
    dir,
    video,
    audio,
    hdr,
    corrupt,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
