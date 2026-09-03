#!/usr/bin/env tsx
/**
 * D04e-3's envelope parity gate: renders `audio-mix-fixtures.ts`'s 6-second,
 * three-cue fixture through the cloud engine's real ffmpeg graph
 * (`buildAudioMixPlan`), computes the reference PCM signal the *same*
 * gain/fade/duck closed form is meant to produce (`referenceMixSamples`
 * below — a faithful port of `apps/web/lib/export/audio-mix.ts`'s
 * `mixSfxCueIntoChunk`, not an import of it: apps do not import one another
 * in this monorepo, the same rule `run-sfx-parity.ts`'s own
 * `browserDuckGainAt` already follows), and compares the two in 50ms
 * RMS-dB windows (`audio-mix-parity.ts`'s `computeAudioMixParity`).
 *
 * Writes `results.json`'s `audioMix` key, merge-preserving next to
 * `edits`/`audio`/`titles`/`sfx` — reads the file first, replaces only its
 * own key, same convention every other `run-*-parity.ts` in this directory
 * follows.
 *
 * Run: `pnpm --filter @montaj/render parity:audio-mix`.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { RenderManifestSchema, withSignature } from "@montaj/render-manifest";
import { fixtureManifest } from "@montaj/render-manifest/testing";
import { buildTimeMap } from "@montaj/timemap";

import {
  AUDIO_MIX_FIXTURE_CUES,
  AUDIO_MIX_SPEECH_RANGES,
  CLIP_DURATION_MS,
  SAMPLE_RATE,
  type AudioMixFixtureCue,
} from "./audio-mix-fixtures.js";
import { computeAudioMixParity, cueWindowIsPresent, type PcmSignal } from "./audio-mix-parity.js";
import { buildFfmpegArgs } from "../src/ffmpeg/graph.js";

const run = promisify(execFile);
const RESULTS_PATH = join(__dirname, "results.json");
export const TOLERANCE_DB = 0.5;

/** `10^(db/20)` — matches `apps/render/src/ffmpeg/sfx-duck-expr.ts#dbToLinear`
 * and `apps/web/lib/export/audio-mix.ts`'s import of the same from `engine.ts`. */
function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** A faithful re-implementation of `apps/web/lib/export/audio-mix.ts`'s
 * `duckGainAt`/`engine.ts`'s `duckGainAt` trapezoid. */
function duckGainAt(
  tMs: number,
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
  duckDb: number,
  rampMs: number,
): number {
  const duckedGain = dbToLinear(duckDb);
  let deepest = 1;
  for (const range of speechRanges) {
    const outerStart = range.startMs - rampMs;
    const outerEnd = range.endMs + rampMs;
    if (tMs < outerStart || tMs > outerEnd) continue;
    const distanceIn = Math.max(0, Math.min(tMs - outerStart, outerEnd - tMs));
    const depth = Math.min(1, distanceIn / (2 * rampMs));
    deepest = Math.min(deepest, 1 + depth * (duckedGain - 1));
  }
  return deepest;
}

/** Decodes a WAV file to mono `Float32Array` PCM at `SAMPLE_RATE`, via ffmpeg. */
async function decodeToPcm(path: string): Promise<Float32Array> {
  const scratch = await mkdtemp(join(tmpdir(), "d04e-parity-pcm-"));
  const pcmPath = join(scratch, "out.f32le");
  try {
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        path,
        "-map",
        "0:a",
        "-f",
        "f32le",
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        pcmPath,
      ],
      { timeout: 60_000, windowsHide: true },
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
    const buffer = await readFile(pcmPath);
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The reference mixed signal: a silent `CLIP_DURATION_MS`-long buffer with
 * every fixture cue's samples added in, at its own output-clock position —
 * `apps/web/lib/export/audio-mix.ts`'s `mixSfxCueIntoChunk` per-sample
 * gain/fade/duck arithmetic, ported here (no timemap remap: the fixture has
 * no cuts, so a cue's source-clock window *is* its output-clock window).
 */
function referenceMixSamples(
  cues: readonly { readonly cue: AudioMixFixtureCue; readonly buffer: Float32Array }[],
  speechRanges: readonly { readonly startMs: number; readonly endMs: number }[],
): Float32Array {
  const totalSamples = Math.round((CLIP_DURATION_MS / 1000) * SAMPLE_RATE);
  const output = new Float32Array(totalSamples);

  for (const { cue, buffer } of cues) {
    const cueDurationMs = cue.endMs - cue.startMs;
    const gainLinear = dbToLinear(cue.gainDb);
    const startSample = Math.round((cue.startMs / 1000) * SAMPLE_RATE);

    for (let i = 0; i < buffer.length; i += 1) {
      const outputIndex = startSample + i;
      if (outputIndex < 0 || outputIndex >= output.length) continue;

      const assetMs = (i / SAMPLE_RATE) * 1000;
      const outputMs = cue.startMs + assetMs;
      let gain = gainLinear;
      if (cue.fadeInMs > 0 && assetMs < cue.fadeInMs) {
        gain *= Math.max(0, assetMs / cue.fadeInMs);
      }
      if (cue.fadeOutMs > 0 && assetMs > cueDurationMs - cue.fadeOutMs) {
        gain *= Math.max(0, (cueDurationMs - assetMs) / cue.fadeOutMs);
      }
      if (cue.duck !== null) {
        gain *= duckGainAt(outputMs, speechRanges, cue.duck.depthDb, cue.duck.attackMs);
      }

      // eslint-disable-next-line security/detect-object-injection -- bracket access on a loop-bounded index, not attacker-controlled
      output[outputIndex] = (output[outputIndex] ?? 0) + (buffer[i] ?? 0) * gain;
    }
  }

  return output;
}

/** A silent base clip — real video + a present-but-silent audio stream —
 * the same shape `audio-mix.integration.test.ts`'s `makeSilentClip` uses. */
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
      `testsrc2=size=320x240:rate=10:duration=${String(CLIP_DURATION_MS / 1000)}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${String(SAMPLE_RATE)}:cl=mono:duration=${String(CLIP_DURATION_MS / 1000)}`,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      "-t",
      String(CLIP_DURATION_MS / 1000),
      path,
    ],
    { timeout: 120_000, windowsHide: true },
  );
}

/** Renders the fixture's cloud side for real, and returns its mixed PCM. */
async function renderCloudMix(scratch: string): Promise<Float32Array> {
  const silentClip = join(scratch, "silent.mov");
  await makeSilentClip(silentClip);

  const unsigned = fixtureManifest({
    output: { width: 320, height: 240, fps: 10, crf: 30, container: "mov" },
    timemap: { sourceDurationMs: CLIP_DURATION_MS, snapCutsToFrames: false, edits: [] },
    audio: { strategy: "passthrough", codec: "pcm", bitrateKbps: 96 },
  });
  const map = buildTimeMap({ sourceDurationMs: CLIP_DURATION_MS, edits: [] });

  const outputPath = join(scratch, "mixed.mov");
  const plan = buildFfmpegArgs({
    manifest: RenderManifestSchema.parse(withSignature(unsigned, "audio-mix-parity-secret")),
    sourcePath: silentClip,
    sourceWidth: 320,
    sourceHeight: 240,
    sourceHasAudio: true,
    spans: map.spans,
    outputDurationMs: map.outputDurationMs,
    outputPath,
    encoder: "libx264",
    sfxCues: AUDIO_MIX_FIXTURE_CUES.map((cue) => ({
      itemId: cue.itemId,
      startMs: cue.startMs,
      endMs: cue.endMs,
      gainDb: cue.gainDb,
      fadeInMs: cue.fadeInMs,
      fadeOutMs: cue.fadeOutMs,
      duck: cue.duck,
      localPath: cue.localPath,
    })),
    timemap: map,
    speechRanges: AUDIO_MIX_SPEECH_RANGES,
  });

  const frameBytes = 320 * 240 * 4;
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

  return decodeToPcm(outputPath);
}

export interface AudioMixMeasurement {
  readonly generatedAt: string;
  readonly toleranceDb: number;
  readonly windowMs: number;
  readonly sampleCount: number;
  readonly maxDeviationDb: number;
  readonly pass: boolean;
  readonly cueWindowsPresent: Readonly<
    Record<string, { readonly reference: boolean; readonly cloud: boolean }>
  >;
}

export async function measureAudioMixParity(
  now: string = new Date().toISOString(),
): Promise<AudioMixMeasurement> {
  const scratch = await mkdtemp(join(tmpdir(), "d04e-parity-"));
  try {
    const decodedCues = await Promise.all(
      AUDIO_MIX_FIXTURE_CUES.map(async (cue) => ({
        cue,
        buffer: await decodeToPcm(cue.localPath),
      })),
    );
    const reference: PcmSignal = {
      samples: referenceMixSamples(decodedCues, AUDIO_MIX_SPEECH_RANGES),
      sampleRate: SAMPLE_RATE,
    };
    const cloud: PcmSignal = {
      samples: await renderCloudMix(scratch),
      sampleRate: SAMPLE_RATE,
    };

    const result = computeAudioMixParity(reference, cloud, {
      windowMs: 50,
      toleranceDb: TOLERANCE_DB,
    });

    const cueWindowsPresent: Record<string, { reference: boolean; cloud: boolean }> = {};
    for (const cue of AUDIO_MIX_FIXTURE_CUES) {
      cueWindowsPresent[cue.itemId] = {
        reference: cueWindowIsPresent(reference, cue.startMs, cue.endMs),
        cloud: cueWindowIsPresent(cloud, cue.startMs, cue.endMs),
      };
    }

    return {
      generatedAt: now,
      toleranceDb: TOLERANCE_DB,
      windowMs: 50,
      sampleCount: result.windows.length,
      maxDeviationDb: result.maxDeviationDb,
      pass:
        result.pass &&
        Object.values(cueWindowsPresent).every((entry) => entry.reference && entry.cloud),
      cueWindowsPresent,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function existingResults(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(RESULTS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const measurement = await measureAudioMixParity();
  const merged = { ...(await existingResults()), audioMix: measurement };
  await writeFile(RESULTS_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  // eslint-disable-next-line no-console
  console.log(
    `audio mix parity: max deviation ${measurement.maxDeviationDb.toFixed(3)}dB ` +
      `over ${String(measurement.sampleCount)} windows (tolerance ${String(TOLERANCE_DB)}dB), ` +
      `pass: ${String(measurement.pass)}`,
  );
  if (!measurement.pass) process.exitCode = 1;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("parity/run-audio-mix-parity.ts") === true) {
  void main();
}
