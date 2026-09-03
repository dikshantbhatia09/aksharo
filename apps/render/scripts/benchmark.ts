/**
 * The render benchmark: seconds of output per second of wall clock, and the
 * vCPU-seconds per output minute that `05 §12` prices the cloud render at.
 *
 *   pnpm --filter @montaj/render bench
 *   pnpm --filter @montaj/render bench -- --seconds 30 --preset 4k
 *
 * It renders the same fixtures the tests assert on, through the same pipeline,
 * with a directory-backed store standing in for R2 — so the number measures the
 * renderer and the encoder rather than a network.
 *
 * `--cpus` reports the vCPU-second figure against a named core count (default:
 * this machine's), because `05 §12`'s row is per vCPU and a 16-core desktop and
 * a 4-vCPU container do not compare otherwise. `--workers 0` rasterises inline
 * on the main thread, which is how the before/after rows in `BENCHMARK.md` were
 * taken from one binary.
 */

import { mkdtemp } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

import { renderVideo } from "../src/render/pipeline.js";
import { rawKey } from "../src/storage.js";
import {
  createDirectoryStore,
  FIXTURE_IDS,
  makeSyntheticClip,
  removeQuietly,
  samplePayload,
} from "../src/testing.js";

import type { VideoEncoder } from "../src/ffmpeg/graph.js";

const SECRET = "benchmark-secret";

interface Preset {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly crf: number;
  readonly encoderPreset: string;
}

const PRESETS: Readonly<Record<string, Preset>> = {
  "1080p": {
    name: "1080p",
    width: 1080,
    height: 1920,
    fps: 30,
    crf: 20,
    encoderPreset: "veryfast",
  },
  "540p": { name: "540p", width: 540, height: 960, fps: 30, crf: 20, encoderPreset: "veryfast" },
  "4k": { name: "4K", width: 2160, height: 3840, fps: 30, crf: 18, encoderPreset: "veryfast" },
};

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const seconds = Number(flag("seconds", "30"));
  const presetName = flag("preset", "1080p");
  const cpuCount = Number(flag("cpus", String(cpus().length)));
  const encoder = flag("encoder", "libx264") as VideoEncoder;
  const workersFlag = flag("workers", "");
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const preset = PRESETS[presetName];
  if (preset === undefined) {
    throw new Error(`unknown preset ${presetName}; try ${Object.keys(PRESETS).join(", ")}`);
  }

  const scratch = await mkdtemp(join(tmpdir(), "a20-bench-"));
  try {
    const rawStore = createDirectoryStore(join(scratch, "raw"));
    const derivedStore = createDirectoryStore(join(scratch, "derived"));

    const clip = join(scratch, "clip.mp4");
    process.stdout.write(`generating a ${String(seconds)} s ${preset.name} clip with ffmpeg…\n`);
    await makeSyntheticClip(clip, {
      seconds,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
    });
    const key = rawKey(FIXTURE_IDS.workspaceId, FIXTURE_IDS.projectId, FIXTURE_IDS.mediaId, "mp4");
    await rawStore.seed(key, clip);

    const payload = await samplePayload(
      SECRET,
      {
        source: {
          mediaId: FIXTURE_IDS.mediaId,
          bucket: "raw",
          key,
          durationMs: seconds * 1000,
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
        },
        timemap: { sourceDurationMs: seconds * 1000, edits: [], snapCutsToFrames: false },
        output: {
          kind: "video",
          preset: "custom",
          aspect: "9:16",
          width: preset.width,
          height: preset.height,
          fps: preset.fps,
          container: "mp4",
          videoCodec: "h264",
          crf: preset.crf,
          encoderPreset: preset.encoderPreset,
        },
        caps: {
          maxWidth: 3840,
          maxHeight: 3840,
          maxDurationMs: 60 * 60_000,
          maxFps: 60,
          allowAlpha: true,
        },
        watermark: null,
      },
      seconds * 1000,
    );

    process.stdout.write(`rendering…\n`);
    const outcome = await renderVideo(payload, FIXTURE_IDS.workspaceId, {
      rawStore,
      derivedStore,
      secret: SECRET,
      encoder,
      workDir: scratch,
      ...(workersFlag === "" ? {} : { rasterWorkers: Number(workersFlag) }),
    });

    const wallSeconds = outcome.wallClockMs / 1000;
    const outputSeconds = outcome.outputDurationMs / 1000;
    const realtime = outputSeconds / wallSeconds;
    const vcpuSecondsPerOutputMinute = (wallSeconds * cpuCount * 60) / outputSeconds;

    const rows: [string, string][] = [
      [
        "preset",
        `${preset.name} ${String(preset.width)}×${String(preset.height)}@${String(preset.fps)}`,
      ],
      ["encoder", encoder],
      [
        "rasteriser",
        outcome.rasterWorkers === 0
          ? "inline (main thread)"
          : `${String(outcome.rasterWorkers)} worker threads`,
      ],
      ["cores counted", String(cpuCount)],
      ["output", `${outputSeconds.toFixed(1)} s`],
      ["wall clock", `${wallSeconds.toFixed(2)} s`],
      ["throughput", `${realtime.toFixed(2)}× realtime`],
      [
        "frames",
        `${String(outcome.frames.requested)} asked, ${String(outcome.frames.rasterised)} rasterised`,
      ],
      ["frame cache", `${(outcome.frames.reuseRatio * 100).toFixed(1)}% reused`],
      ["vCPU-s / output minute", vcpuSecondsPerOutputMinute.toFixed(1)],
      ["output size", `${(outcome.sizeBytes / 1_000_000).toFixed(2)} MB`],
      ["fonts", outcome.fontSource],
    ];
    const width = Math.max(...rows.map(([label]) => label.length));
    process.stdout.write("\n");
    for (const [label, value] of rows) {
      process.stdout.write(`${label.padEnd(width)}  ${value}\n`);
    }
    process.stdout.write(`\nffmpeg  ${outcome.ffmpegSummary}\n`);
    process.stdout.write(`filter  ${outcome.filterGraph || "(none)"}\n`);
  } finally {
    await removeQuietly(scratch);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
