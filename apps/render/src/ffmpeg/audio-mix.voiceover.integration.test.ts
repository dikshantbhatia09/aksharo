/**
 * The voice-over hook's "real ffmpeg" proof (2026-10-01): a render whose
 * manifest carries a play-through cue with a `dialogueDuck` actually runs
 * through ffmpeg, and the clip's own sound is measurably quieter under the
 * voice and untouched after it - checked against real encoded and decoded
 * bytes, not just the filter strings `audio-mix.voiceover.test.ts` pins.
 *
 * The "voice" here is silence (an `anullsrc` WAV), so what is measured in the
 * window is the dialogue alone: a 440 Hz tone standing in for the speaker.
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
import { buildTimeMap, cutEdit } from "@montaj/timemap";

import { removeQuietly } from "../testing.js";
import { buildFfmpegArgs } from "./graph.js";
import { probeMedia } from "./probe.js";

import type { SfxMixCue } from "./audio-mix.js";

const run = promisify(execFile);
const CLIP_SECONDS = 5;

let scratch: string;
let toneClip: string;
let silentVoice: string;

async function ffmpeg(args: string[]): Promise<void> {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 120_000,
    windowsHide: true,
  });
}

async function windowRmsDb(sourcePath: string, startSec: number, endSec: number): Promise<number> {
  const pcmPath = `${sourcePath}.${String(startSec)}.pcm`;
  await ffmpeg([
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
  ]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path this test built in its own scratch dir
  const buffer = await readFile(pcmPath);
  const samples = buffer.length / 2;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const sample = buffer.readInt16LE(i * 2) / 32_768;
    sum += sample * sample;
  }
  return 20 * Math.log10(Math.max(samples > 0 ? Math.sqrt(sum / samples) : 0, 1e-9));
}

async function render(
  outputPath: string,
  cues: readonly SfxMixCue[],
  cutMs?: [number, number],
): Promise<void> {
  const edits = cutMs === undefined ? [] : [cutEdit(cutMs[0], cutMs[1])];
  const unsigned = fixtureManifest({
    output: { width: 320, height: 240, fps: 10, crf: 30 },
    timemap: { sourceDurationMs: CLIP_SECONDS * 1_000, snapCutsToFrames: false, edits },
    audio: { strategy: "passthrough", codec: "aac", bitrateKbps: 96 },
  }) as UnsignedRenderManifest;
  const manifest: RenderManifest = RenderManifestSchema.parse(
    withSignature(unsigned, "voiceover-integration-secret"),
  );
  const probe = await probeMedia(toneClip);
  const map = buildTimeMap({ sourceDurationMs: CLIP_SECONDS * 1_000, edits });
  const plan = buildFfmpegArgs({
    manifest,
    sourcePath: toneClip,
    sourceWidth: probe.displayWidth,
    sourceHeight: probe.displayHeight,
    sourceHasAudio: probe.audio !== null,
    spans: map.spans,
    outputDurationMs: map.outputDurationMs,
    outputPath,
    encoder: "libx264",
    ...(cues.length === 0 ? {} : { sfxCues: cues, timemap: map, speechRanges: [] }),
  });
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
    for (let i = 0; i < plan.overlayFrames; i += 1) proc.stdin?.write(Buffer.alloc(frameBytes, 0));
    proc.stdin?.end();
  });
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "voiceover-mix-"));
  toneClip = join(scratch, "tone.mp4");
  silentVoice = join(scratch, "voice.wav");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x240:rate=10:duration=${String(CLIP_SECONDS)}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:sample_rate=48000:duration=${String(CLIP_SECONDS)}`,
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
    toneClip,
  ]);
  await ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "2", silentVoice]);
}, 120_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("voice-over hook: real ffmpeg ducks the clip under the voice", () => {
  it("pulls the dialogue down under the voice, through a cut, and lets it back up after", async () => {
    const baseline = join(scratch, "baseline.mp4");
    const ducked = join(scratch, "ducked.mp4");
    const voice: SfxMixCue = {
      itemId: "01JVOICE0000000000000000000",
      startMs: 0,
      endMs: 2_000,
      gainDb: 0,
      fadeInMs: 20,
      fadeOutMs: 120,
      duck: null,
      localPath: silentVoice,
      playThrough: true,
      dialogueDuck: { depthDb: -14, attackMs: 200, releaseMs: 300 },
    };
    // A cut inside the voice: it plays straight through it, so the duck
    // covers the voice's whole 2 s on the output clock.
    await render(baseline, [], [800, 1_000]);
    await render(ducked, [voice], [800, 1_000]);

    const underBase = await windowRmsDb(baseline, 0.5, 1.6);
    const underDucked = await windowRmsDb(ducked, 0.5, 1.6);
    expect(underBase - underDucked).toBeGreaterThanOrEqual(10);

    const afterBase = await windowRmsDb(baseline, 3.0, 4.0);
    const afterDucked = await windowRmsDb(ducked, 3.0, 4.0);
    expect(Math.abs(afterBase - afterDucked)).toBeLessThan(1);
  }, 120_000);
});
