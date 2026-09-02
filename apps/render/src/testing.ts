/**
 * Test fixtures for the render service: a synthetic clip, a projection built
 * from the sample EDG, a signed manifest, and an object store backed by a
 * directory.
 *
 * The projection comes from `@montaj/edg`'s committed `sample-project.json` and
 * `sample-transcript.json` rather than from hand-written segments, so the
 * end-to-end test renders the same Hinglish captions the rest of the repo is
 * tested against — including the Devanagari fallback that a naive shaper draws
 * as tofu.
 *
 * Exported from the package (not just from a `.test.ts`) because the benchmark
 * script builds the same inputs; a benchmark measured on different frames from
 * the ones the tests assert is not a measurement of anything.
 */

import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import { loadSystemStyleMap } from "@montaj/caption-styles";
import { type RenderManifest, type UnsignedRenderManifest } from "@montaj/render-manifest";
import { FIXTURE_IDS, signedFixtureManifest } from "@montaj/render-manifest/testing";

import { type RenderProjection, type RenderVideoPayload } from "./queues.js";
import { type ObjectStore, type PutOptions } from "./storage.js";

const run = promisify(execFile);

export { FIXTURE_IDS, signedFixtureManifest };
export type { RenderManifest, UnsignedRenderManifest };

/** The EDG fixtures live in `@montaj/edg`; resolve them through its package.json. */
export function edgFixtureDir(): string {
  return join(dirname(require.resolve("@montaj/edg/package.json")), "fixtures");
}

interface SampleProject {
  readonly canvas: { readonly width: number; readonly height: number };
  readonly segments: readonly {
    readonly id: string;
    readonly seq: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly startWordId: string;
    readonly endWordId: string;
    readonly styleRef?: string;
    readonly textOverrides?: Record<string, string>;
    readonly hidden?: boolean;
  }[];
  readonly transcript: {
    readonly speakers?: readonly { readonly id: string; readonly color?: string }[];
  };
}

interface SampleTranscript {
  readonly chunks: readonly {
    readonly words: readonly {
      readonly wid: string;
      readonly s: number;
      readonly e: number;
      readonly t: string;
      readonly sp?: string;
      readonly filler?: boolean;
      readonly deleted?: boolean;
      readonly scripts?: Record<string, string>;
    }[];
  }[];
}

/**
 * The sample project as a render projection, clipped to `limitMs`.
 *
 * The fixture is ninety seconds long; a test renders ten, so the segments and
 * words past the limit are dropped rather than rendered into frames nobody
 * asserts on.
 */
export async function sampleProjection(limitMs = 10_000): Promise<RenderProjection> {
  const dir = edgFixtureDir();
  const project = JSON.parse(
    await readFile(join(dir, "sample-project.json"), "utf8"),
  ) as SampleProject;
  const transcript = JSON.parse(
    await readFile(join(dir, "sample-transcript.json"), "utf8"),
  ) as SampleTranscript;

  const words = transcript.chunks
    .flatMap((chunk) => chunk.words)
    .filter((word) => word.s < limitMs);
  const live = new Set(words.map((word) => word.wid));
  const segments = project.segments.filter(
    (segment) =>
      segment.startMs < limitMs && live.has(segment.startWordId) && live.has(segment.endWordId),
  );

  const speakerColours: Record<string, string> = {};
  for (const speaker of project.transcript.speakers ?? []) {
    if (speaker.color !== undefined) speakerColours[speaker.id] = speaker.color;
  }

  return {
    canvas: project.canvas,
    segments: segments.map((segment) => ({
      id: segment.id,
      seq: segment.seq,
      startMs: segment.startMs,
      endMs: Math.min(segment.endMs, limitMs),
      startWordId: segment.startWordId,
      endWordId: segment.endWordId,
      ...(segment.styleRef === undefined ? {} : { styleRef: segment.styleRef }),
      ...(segment.textOverrides === undefined ? {} : { textOverrides: segment.textOverrides }),
      ...(segment.hidden === undefined ? {} : { hidden: segment.hidden }),
    })),
    words: words.map((word) => ({
      wid: word.wid,
      s: word.s,
      e: word.e,
      t: word.t,
      ...(word.sp === undefined ? {} : { sp: word.sp }),
      ...(word.filler === undefined ? {} : { filler: word.filler }),
      ...(word.deleted === undefined ? {} : { deleted: word.deleted }),
      ...(word.scripts === undefined ? {} : { scripts: word.scripts }),
    })),
    speakerColours,
  };
}

/** Every system StyleDoc, as the payload carries them. */
export function sampleStyles(): Record<string, unknown> {
  const styles: Record<string, unknown> = {};
  for (const [id, document] of loadSystemStyleMap()) styles[id] = document;
  return styles;
}

/** A complete `render.video` payload for the sample project. */
export async function samplePayload(
  secret: string,
  overrides: Parameters<typeof signedFixtureManifest>[1] = {},
  limitMs = 10_000,
): Promise<RenderVideoPayload> {
  return {
    manifest: signedFixtureManifest(secret, overrides, Date.now()),
    projection: await sampleProjection(limitMs),
    styles: sampleStyles(),
    path: "skia",
    script: "roman",
    dropFillers: false,
  };
}

/**
 * A synthetic clip: a moving test pattern with a sine tone.
 *
 * `testsrc2` rather than a still colour because a static picture compresses to
 * nothing and would hide an encoder that was never given any frames; the moving
 * pattern also makes a wrongly-placed caption obvious in the output file.
 */
export async function makeSyntheticClip(
  path: string,
  options: {
    seconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    audio?: boolean;
    ffmpegPath?: string;
  } = {},
): Promise<string> {
  const seconds = options.seconds ?? 10;
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const fps = options.fps ?? 30;
  await mkdir(dirname(path), { recursive: true });
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${String(width)}x${String(height)}:rate=${String(fps)}:duration=${String(seconds)}`,
  ];
  if (options.audio !== false) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${String(seconds)}:sample_rate=48000`,
    );
  }
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-t",
    String(seconds),
  );
  if (options.audio !== false) args.push("-c:a", "aac", "-b:a", "96k");
  args.push(path);
  await run(options.ffmpegPath ?? "ffmpeg", args, { timeout: 300_000, windowsHide: true });
  return path;
}

/** A 64×64 PNG with a visible mark, for the watermark case. */
export async function makeWatermarkPng(path: string, ffmpegPath = "ffmpeg"): Promise<Uint8Array> {
  await mkdir(dirname(path), { recursive: true });
  await run(
    ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=red@0.9:s=64x64,format=rgba",
      "-frames:v",
      "1",
      path,
    ],
    { timeout: 60_000, windowsHide: true },
  );
  return new Uint8Array(await readFile(path));
}

export interface DirectoryStore extends ObjectStore {
  /** Everything written, in order, so a test can assert on the keys. */
  readonly written: readonly { key: string; sizeBytes: number }[];
  /** Reads back what was written under `key`. */
  read(key: string): Promise<Buffer>;
  /** Puts a local file in the store under `key`. */
  seed(key: string, source: string): Promise<void>;
  seedBytes(key: string, bytes: Uint8Array): Promise<void>;
  /** Local path a key maps to. */
  pathFor(key: string): string;
}

/**
 * An object store backed by a directory.
 *
 * The integration test uses this rather than MinIO for the same reason
 * `apps/worker-ai` fakes boto3: the thing under test is the render, and a
 * container in the loop turns a five-second test into a thirty-second one
 * without testing anything the SDK does not already test. `createObjectStore`'s
 * SigV4/path-style configuration is exercised against the shared MinIO stack by
 * hand and is documented in the README.
 */
export function createDirectoryStore(root: string, bucket = "test-bucket"): DirectoryStore {
  const written: { key: string; sizeBytes: number }[] = [];
  const pathFor = (key: string): string => join(root, key.replace(/[^A-Za-z0-9._/-]/g, "_"));

  return {
    bucket,
    written,
    pathFor,
    async seed(key, source) {
      const destination = pathFor(key);
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(createReadStream(source), createWriteStream(destination));
    },
    async seedBytes(key, bytes) {
      const destination = pathFor(key);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    },
    async read(key) {
      return readFile(pathFor(key));
    },
    async download(key, destination) {
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(createReadStream(pathFor(key)), createWriteStream(destination));
      return destination;
    },
    async getBytes(key) {
      return new Uint8Array(await readFile(pathFor(key)));
    },
    async upload(key, source, _options?: PutOptions) {
      const destination = pathFor(key);
      await mkdir(dirname(destination), { recursive: true });
      await pipeline(createReadStream(source), createWriteStream(destination));
      const bytes = await readFile(destination);
      written.push({ key, sizeBytes: bytes.byteLength });
      return bytes.byteLength;
    },
    async putBytes(key, bytes, _options?: PutOptions) {
      const destination = pathFor(key);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      written.push({ key, sizeBytes: bytes.byteLength });
      return bytes.byteLength;
    },
  };
}

/** Removes a scratch directory, ignoring a Windows handle that has not closed. */
export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
}
