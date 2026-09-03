/**
 * D04e increment 1's "real ffmpeg" proof: `buildFfmpegArgs`'s output for a
 * manifest carrying one accepted `sfx` cue is actually run through ffmpeg, and
 * the resulting file's audio in the cue's own window is measurably louder
 * than the same render with no cue — the property the brief asks for ("RMS in
 * the cue window rises by ≥6 dB vs. a render without cues"), checked against
 * real encoded/decoded bytes rather than the filter-string unit tests in
 * `audio-mix.test.ts`/`graph.test.ts`.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RenderManifestSchema, withSignature } from "@montaj/render-manifest";
import type { RenderManifest, UnsignedRenderManifest } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";
import { buildTimeMap } from "@montaj/timemap";

import { removeQuietly } from "../testing.js";
import { buildFfmpegArgs } from "./graph.js";
import { probeMedia } from "./probe.js";

import type { SfxMixCue } from "./audio-mix.js";

const run = promisify(execFile);

const CLIP_SECONDS = 4;
const CUE_ASSET = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "audio-pack",
  "wav",
  "sfx-ding-01.wav",
);
const CUE_DURATION_MS = 500;
const CUE_START_MS = 1_500;

let scratch: string;
let silentClip: string;

/** A clip with a *present but silent* audio stream — `-f lavfi -i anullsrc`
 * rather than `testing.ts`'s `makeSyntheticClip` sine, so the baseline render
 * has a real audio track (`sourceHasAudio: true`) to compare the cue-added
 * render against, at a near-zero RMS floor. */
async function makeSilentClip(path: string): Promise<void> {
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x240:rate=10:duration=${String(CLIP_SECONDS)}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=48000:cl=stereo:duration=${String(CLIP_SECONDS)}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-t",
      String(CLIP_SECONDS),
      path,
    ],
    { timeout: 120_000, windowsHide: true },
  );
}

/** RMS (dBFS) of one PCM window, decoded fresh from `sourcePath` via an
 * accurate `-ss`/`-to` decode rather than reading the muxed container's own
 * frame boundaries. */
async function windowRmsDb(sourcePath: string, startSec: number, endSec: number): Promise<number> {
  const pcmPath = `${sourcePath}.window.pcm`;
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      sourcePath,
      "-ss",
      startSec.toFixed(3),
      "-to",
      endSec.toFixed(3),
      "-map",
      "0:a",
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "48000",
      pcmPath,
    ],
    { timeout: 60_000, windowsHide: true },
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
  const buffer = await readFile(pcmPath);
  const samples = buffer.length / 2;
  let sumSquares = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = buffer.readInt16LE(i * 2) / 32_768;
    sumSquares += sample * sample;
  }
  const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0;
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

async function renderWithCues(outputPath: string, cues: readonly SfxMixCue[]): Promise<void> {
  const unsigned = fixtureManifest({
    output: { width: 320, height: 240, fps: 10, crf: 30 },
    timemap: { sourceDurationMs: CLIP_SECONDS * 1_000, snapCutsToFrames: false, edits: [] },
    audio: { strategy: "passthrough", codec: "aac", bitrateKbps: 96 },
  }) as UnsignedRenderManifest;
  const manifest: RenderManifest = RenderManifestSchema.parse(
    withSignature(unsigned, "audio-mix-integration-secret"),
  );
  const probe = await probeMedia(silentClip);
  const map = buildTimeMap({ sourceDurationMs: manifest.timemap.sourceDurationMs, edits: [] });

  const plan = buildFfmpegArgs({
    manifest,
    sourcePath: silentClip,
    sourceWidth: probe.displayWidth,
    sourceHeight: probe.displayHeight,
    sourceHasAudio: probe.audio !== null,
    spans: map.spans,
    outputDurationMs: map.outputDurationMs,
    outputPath,
    encoder: "libx264",
    ...(cues.length === 0 ? {} : { sfxCues: cues, timemap: map, speechRanges: [] }),
  });

  // The overlay pipe input needs *some* rgba frames or ffmpeg blocks on stdin
  // forever; feed it exactly what the plan asked for, all transparent.
  const frameBytes = manifest.output.width * manifest.output.height * 4;
  await new Promise<void>((resolve, reject) => {
    const proc = execFile("ffmpeg", plan.args, {
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 32,
    });
    proc.on("error", reject);
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${String(code)}`)),
    );
    for (let i = 0; i < plan.overlayFrames; i += 1) {
      proc.stdin?.write(Buffer.alloc(frameBytes, 0));
    }
    proc.stdin?.end();
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "d04e-audio-mix-"));
  silentClip = join(scratch, "silent.mp4");
  await makeSilentClip(silentClip);
}, 120_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("D04e-1: real ffmpeg render mixes an sfx cue in", () => {
  it("raises the cue window's RMS by at least 6 dB vs. the same render without cues", async () => {
    const baselinePath = join(scratch, "baseline.mp4");
    const mixedPath = join(scratch, "mixed.mp4");

    const cue: SfxMixCue = {
      itemId: "01JD04EDING000000000000000",
      startMs: CUE_START_MS,
      endMs: CUE_START_MS + CUE_DURATION_MS,
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      duck: null,
      localPath: CUE_ASSET,
    };

    await renderWithCues(baselinePath, []);
    await renderWithCues(mixedPath, [cue]);

    const windowStartSec = CUE_START_MS / 1000;
    const windowEndSec = (CUE_START_MS + CUE_DURATION_MS) / 1000;

    const baselineRms = await windowRmsDb(baselinePath, windowStartSec, windowEndSec);
    const mixedRms = await windowRmsDb(mixedPath, windowStartSec, windowEndSec);

    expect(mixedRms - baselineRms).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
