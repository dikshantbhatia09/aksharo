/**
 * `renderCompilation` end to end with the real ffmpeg on tiny generated clips
 * (2026-10-03): a mix of frame rates, a clip of another shape, a clip with no
 * sound and a title card, joined and measured frame by frame.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CompilationError, renderCompilation } from "./join.js";
import { fadeFramesFor, totalFrames } from "./plan.js";
import { brandAssetKey } from "../storage.js";
import {
  createDirectoryStore,
  makeWatermarkPng,
  removeQuietly,
  type DirectoryStore,
} from "../testing.js";

import type { RenderCompilationPayload } from "../queues.js";

const run = promisify(execFile);

const WS = "01JCWS0000000000000000000A";
const OTHER_WS = "01JCWS0000000000000000000B";
const SOURCE_PROJECT = "01JCSRCPR0JECT000000000000";
const LOGO = "01JCASSET00000000000000000";
const WIDTH = 180;
const HEIGHT = 320;

let scratch: string;
let workDir: string;
let store: DirectoryStore;

interface Generated {
  readonly clipId: string;
  readonly key: string;
  readonly durationMs: number;
}

async function makeClip(
  name: string,
  options: {
    colour: string;
    width: number;
    height: number;
    fps: number;
    seconds: number;
    audio: boolean;
  },
  index: number,
): Promise<Generated> {
  const path = join(scratch, `${name}.mp4`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=${options.colour}:s=${String(options.width)}x${String(options.height)}:r=${String(options.fps)}:d=${String(options.seconds)}`,
  ];
  if (options.audio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=44100:duration=${String(options.seconds)}`,
    );
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (options.audio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  await run("ffmpeg", args, { timeout: 120_000, windowsHide: true });
  const project = `01JCC11PPR0JECT00000000000`.slice(0, 25) + String(index);
  const exportId = `01JCEXP0RT000000000000000${String(index)}`;
  const key = `ws/${WS}/p/${project}/exports/${exportId}.mp4`;
  await store.seed(key, path);
  return {
    clipId: `01JCC11P00000000000000000${String(index)}`,
    key,
    durationMs: Math.round(options.seconds * 1000),
  };
}

async function probeCount(
  path: string,
): Promise<{ frames: number; videoS: number; audioS: number }> {
  const { stdout: video } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames,duration",
      "-of",
      "csv=p=0",
      path,
    ],
    { windowsHide: true },
  );
  const { stdout: audio } = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=duration",
      "-of",
      "csv=p=0",
      path,
    ],
    { windowsHide: true },
  );
  const [videoS, frames] = video.trim().split(",").map(Number);
  return { frames: frames ?? 0, videoS: videoS ?? 0, audioS: Number(audio.trim()) };
}

/** The mean colour of frame `n`, or of a small patch of it. */
async function frameRgb(path: string, n: number, crop?: string): Promise<[number, number, number]> {
  const filters = [
    `select=eq(n\\,${String(n)})`,
    ...(crop === undefined ? [] : [crop]),
    "scale=1:1",
    "format=rgb24",
  ];
  const { stdout } = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-vf",
      filters.join(","),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-",
    ],
    { windowsHide: true, encoding: "buffer" },
  );
  const bytes = stdout as unknown as Buffer;
  return [bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0];
}

let clips: Generated[];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "compilation-test-"));
  workDir = join(scratch, "work");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside the job's own scratch folder, not input
  await mkdir(workDir, { recursive: true });
  store = createDirectoryStore(join(scratch, "store"));
  clips = [
    await makeClip(
      "red",
      { colour: "red", width: WIDTH, height: HEIGHT, fps: 30, seconds: 2, audio: true },
      1,
    ),
    // Another rate: 1.52 s at 25 fps is 45.6 frames at 30, so 46.
    await makeClip(
      "blue",
      { colour: "blue", width: WIDTH, height: HEIGHT, fps: 25, seconds: 1.52, audio: true },
      2,
    ),
    // Another shape, and no sound at all.
    await makeClip(
      "green",
      { colour: "green", width: 240, height: 240, fps: 30, seconds: 1.5, audio: false },
      3,
    ),
  ];
  await store.seedBytes(
    brandAssetKey(WS, LOGO, "png"),
    await makeWatermarkPng(join(scratch, "logo.png")),
  );
}, 180_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

function payload(overrides: Partial<RenderCompilationPayload> = {}): RenderCompilationPayload {
  return {
    schemaVersion: 1,
    runId: "01JCRN0000000000000000000A",
    compilationId: "01JCC0MP11AT10N00000000000",
    exportId: "01JCEXP0RT0000000000000000",
    projectId: SOURCE_PROJECT,
    shape: "9:16",
    // A small canvas keeps the test fast; the schema holds real jobs to 1080 x 1920.
    width: WIDTH,
    height: HEIGHT,
    fps: 30,
    fadeMs: 500,
    clips,
    intro: {
      title: "Best of the week",
      durationMs: 1_000,
      background: "#141217",
      text: "#f1ece6",
      logo: { assetId: LOGO, format: "png", width: 64, height: 64 },
    },
    ...overrides,
  };
}

describe("renderCompilation (real ffmpeg)", () => {
  it("joins a card and three unlike clips into one video, frame for frame", async () => {
    const warnings: string[] = [];
    const progress: number[] = [];
    const outcome = await renderCompilation(payload(), WS, {
      derivedStore: store,
      workDir,
      encoderThreads: 2,
      onWarning: (message) => warnings.push(message),
      onProgress: (fraction) => progress.push(fraction),
    });

    // Card 30, red 60, blue 46, green 45, each join a 15-frame fade.
    const counts = [30, 60, 46, 45];
    const fade = fadeFramesFor(15, counts);
    expect(fade).toBe(15);
    const frames = totalFrames(counts, fade);
    expect(outcome.frames).toBe(frames);
    expect(outcome.pieces).toBe(7);
    expect(outcome.result).toMatchObject({
      compilationId: "01JCC0MP11AT10N00000000000",
      exportId: "01JCEXP0RT0000000000000000",
      outputKey: `ws/${WS}/p/${SOURCE_PROJECT}/exports/01JCEXP0RT0000000000000000.mp4`,
      outputMs: Math.round((frames * 1000) / 30),
      width: WIDTH,
      height: HEIGHT,
      fps: 30,
      clips: 3,
      intro: true,
    });
    expect(store.written.map((entry) => entry.key)).toEqual([outcome.result.outputKey]);
    expect(warnings.filter((message) => message.includes("logo"))).toEqual([]);
    expect(progress.at(-1)).toBe(1);

    const out = store.pathFor(outcome.result.outputKey);
    const measured = await probeCount(out);
    expect(measured.frames).toBe(frames);
    expect(Math.abs(measured.audioS - measured.videoS)).toBeLessThan(0.03);

    // The card's first frame is its colour (#141217), before its words come up.
    const [r0, g0, b0] = await frameRgb(out, 0);
    expect(Math.max(Math.abs(r0 - 20), Math.abs(g0 - 18), Math.abs(b0 - 23))).toBeLessThan(10);
    // Card 0-14, fade 15-29, red 30-59, fade 60-74, blue 75-90, fade 91-105, green 106-135.
    const red = await frameRgb(out, 45);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[2]).toBeLessThan(40);
    const between = await frameRgb(out, 67);
    expect(between[0]).toBeGreaterThan(60);
    expect(between[2]).toBeGreaterThan(60);
    const blue = await frameRgb(out, 85);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]).toBeLessThan(40);
    // The square clip is letterboxed into the tall canvas, never cropped.
    const green = await frameRgb(
      out,
      125,
      `crop=4:4:${String(WIDTH / 2 - 2)}:${String(HEIGHT / 2 - 2)}`,
    );
    expect(green[1]).toBeGreaterThan(100);
    const bar = await frameRgb(out, 125, "crop=4:4:88:4");
    expect(Math.max(...bar)).toBeLessThan(30);

    // Nothing is left in the scratch folder.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a path inside the job's own scratch folder, not input
    expect(await readdir(workDir)).toEqual([]);
  }, 180_000);

  it("draws the card without a logo it cannot read, and joins without a card", async () => {
    const warnings: string[] = [];
    const missing = payload({
      exportId: "01JCEXP0RT0000000000000001",
      intro: {
        title: "Best of",
        durationMs: 1_000,
        background: "#f0508a",
        logo: { assetId: "01JCASSET0000000000000000Z", format: "png", width: 64, height: 64 },
      },
    });
    const withCard = await renderCompilation(missing, WS, {
      derivedStore: store,
      workDir,
      encoderThreads: 2,
      onWarning: (message) => warnings.push(message),
    });
    expect(withCard.result.intro).toBe(true);
    expect(warnings.some((message) => message.includes("without its logo"))).toBe(true);

    const { intro: _intro, ...plain } = payload({ exportId: "01JCEXP0RT0000000000000002" });
    const noCard = await renderCompilation(plain, WS, {
      derivedStore: store,
      workDir,
      encoderThreads: 2,
    });
    const counts = [60, 46, 45];
    expect(noCard.frames).toBe(totalFrames(counts, fadeFramesFor(15, counts)));
    expect(noCard.result.intro).toBe(false);
  }, 180_000);

  it("reads nothing outside the job's workspace", async () => {
    const stranger = payload({
      clips: [
        clips[0] as Generated,
        { ...(clips[1] as Generated), key: (clips[1] as Generated).key.replace(WS, OTHER_WS) },
      ],
    });
    await expect(
      renderCompilation(stranger, WS, { derivedStore: store, workDir }),
    ).rejects.toMatchObject({ code: "storage/bad-key" });
    await expect(
      renderCompilation(stranger, WS, { derivedStore: store, workDir }),
    ).rejects.toBeInstanceOf(CompilationError);
  });

  it("refuses a join past the cap once the clips are measured", async () => {
    // Twenty copies of a 2 s clip is 40 s; a cap of 15 minutes is far away, so
    // the cap is checked against a clip that measures far longer than it said.
    const long = join(scratch, "long.mp4");
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
        "color=c=black:s=16x16:r=1:d=920",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        long,
      ],
      { timeout: 120_000, windowsHide: true },
    );
    const key = `ws/${WS}/p/01JCC11PPR0JECT00000000009/exports/01JCEXP0RT0000000000000009.mp4`;
    await store.seed(key, long);
    const { intro: _intro, ...plain } = payload({
      exportId: "01JCEXP0RT0000000000000003",
      clips: [
        clips[0] as Generated,
        { clipId: "01JCC11P000000000000000009", key, durationMs: 10_000 },
      ],
    });
    await expect(
      renderCompilation(plain, WS, { derivedStore: store, workDir, encoderThreads: 2 }),
    ).rejects.toMatchObject({ code: "render/compilation-too-long" });
  }, 180_000);
});
