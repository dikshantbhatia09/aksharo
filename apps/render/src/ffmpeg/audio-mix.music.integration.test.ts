/**
 * A brand kit's music bed (2026-10-04), mixed by real ffmpeg through the whole
 * cloud-render graph (`buildFfmpegArgs`), under a clip with cuts - which is what
 * every Autopilot clip is, once its silences are cut out.
 *
 * The source's own sound is silent, so everything measured is the bed. Speech is
 * where the words are (source clock); two cuts move the second stretch of speech
 * 700 ms earlier on the output clock. What must hold, measured on the encoded
 * file:
 *
 * - the bed is quieter under speech than in the pauses, by about its duck;
 * - it is ducked where the speech is on the OUTPUT clock, not where the words
 *   were in the source (before 2026-10-04 the ducks read source-clock ranges on
 *   the output clock, and ducked the pause after the words instead);
 * - it fades in;
 * - a 4-second track under a 9.3-second clip loops to fill it.
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
import { probeAudioAsset, probeMedia } from "./probe.js";

import type { MusicMixCue } from "./audio-mix.js";

const run = promisify(execFile);

const SOURCE_MS = 10_000;
const EDITS = [cutEdit(3_000, 3_200), cutEdit(5_000, 5_500)];
/** Where the words are, on the source clock. */
const SPEECH = [
  { startMs: 1_000, endMs: 2_000 },
  { startMs: 6_000, endMs: 8_000 },
];
const DUCK_DB = -10;
const RAMP_MS = 250;

let scratch = "";
let silentClip = "";
let bed = "";

async function ffmpeg(args: readonly string[]): Promise<void> {
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    timeout: 120_000,
    windowsHide: true,
  });
}

/** RMS (dBFS) of the output's audio in `[startMs, endMs)`, decoded to mono PCM. */
async function rmsDb(path: string, startMs: number, endMs: number): Promise<number> {
  const pcm = `${path}.${String(startMs)}.pcm`;
  await ffmpeg([
    "-i",
    path,
    "-ss",
    (startMs / 1000).toFixed(3),
    "-to",
    (endMs / 1000).toFixed(3),
    "-map",
    "0:a",
    "-f",
    "s16le",
    "-ac",
    "1",
    "-ar",
    "48000",
    pcm,
  ]);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file this test just wrote in its own scratch directory
  const buffer = await readFile(pcm);
  const samples = buffer.length / 2;
  let sum = 0;
  for (let index = 0; index < samples; index += 1) {
    const sample = buffer.readInt16LE(index * 2) / 32_768;
    sum += sample * sample;
  }
  return 20 * Math.log10(Math.max(samples > 0 ? Math.sqrt(sum / samples) : 0, 1e-9));
}

async function renderWithBed(outputPath: string): Promise<{ outputDurationMs: number }> {
  const unsigned = fixtureManifest({
    output: { width: 320, height: 240, fps: 10, crf: 30 },
    timemap: { sourceDurationMs: SOURCE_MS, snapCutsToFrames: false, edits: EDITS },
    audio: { strategy: "passthrough", codec: "aac", bitrateKbps: 128 },
  }) as UnsignedRenderManifest;
  const manifest: RenderManifest = RenderManifestSchema.parse(
    withSignature(unsigned, "music-bed-integration-secret"),
  );
  const probe = await probeMedia(silentClip);
  const map = buildTimeMap({ sourceDurationMs: SOURCE_MS, edits: EDITS });
  const asset = await probeAudioAsset(bed);
  const music: MusicMixCue = {
    itemId: "01JBRANDBED000000000000000",
    startMs: 0,
    endMs: SOURCE_MS,
    gainDb: -20,
    loopPolicy: "loop",
    bedDuck: { depthDb: DUCK_DB, attackMs: RAMP_MS, releaseMs: 400 },
    localPath: bed,
    assetDurationMs: asset.durationMs,
  };

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
    musicCues: [music],
    timemap: map,
    speechRanges: SPEECH,
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
    for (let index = 0; index < plan.overlayFrames; index += 1) {
      proc.stdin?.write(Buffer.alloc(frameBytes, 0));
    }
    proc.stdin?.end();
  });
  return { outputDurationMs: map.outputDurationMs };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "music-bed-"));
  silentClip = join(scratch, "silent.mp4");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x240:rate=10:duration=${String(SOURCE_MS / 1000)}`,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=48000:cl=stereo:duration=${String(SOURCE_MS / 1000)}`,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-t",
    String(SOURCE_MS / 1000),
    silentClip,
  ]);
  // The track: four seconds of a steady tone, shorter than the clip.
  bed = join(scratch, "track.wav");
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=0.5*sin(2*PI*440*t):s=48000:d=4",
    "-ac",
    "2",
    bed,
  ]);
}, 120_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("a brand kit's music bed, rendered (2026-10-04)", () => {
  it("is ducked under speech on the output clock, fades in, and loops to fill the clip", async () => {
    const output = join(scratch, "bed.mp4");
    const { outputDurationMs } = await renderWithBed(output);
    expect(outputDurationMs).toBe(9_300);

    // The second stretch of speech, 6.0-8.0 s in the source, is 5.3-7.3 s out.
    const pause = await rmsDb(output, 2_400, 2_900);
    const underSpeech = await rmsDb(output, 5_700, 6_900);
    const afterSpeech = await rmsDb(output, 7_700, 8_300);
    const opening = await rmsDb(output, 0, 100);
    const lateInTheClip = await rmsDb(output, 4_300, 4_900);

    // -20 dB on a tone at half scale (-9 dBFS RMS), read back as mono: about -32 dBFS.
    expect(pause).toBeGreaterThan(-36);
    expect(pause).toBeLessThan(-28);
    // Quieter under the words by about the duck.
    expect(pause - underSpeech).toBeGreaterThan(8);
    expect(pause - underSpeech).toBeLessThan(12);
    // Loud again once the words are over on the OUTPUT clock - where the
    // source-clock words (up to 8.0 s) would still have held it down.
    expect(Math.abs(afterSpeech - pause)).toBeLessThan(1.5);
    // Faded in.
    expect(pause - opening).toBeGreaterThan(6);
    // Past the four seconds of the track: it loops rather than falling silent.
    expect(Math.abs(lateInTheClip - pause)).toBeLessThan(1.5);
  }, 120_000);
});
