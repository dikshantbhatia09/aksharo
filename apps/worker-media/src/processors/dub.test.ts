import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkPayload, fitOf, muxArgs, processDub } from "./dub.js";
import { MediaJobError } from "../errors.js";

import type { DubPayload } from "./dub.js";
import type { JobContext } from "../runtime.js";
import type { Settings } from "../settings.js";
import type { ObjectStore } from "../storage.js";

/**
 * `media.dub` (2026-10-04) with real ffmpeg on tiny generated inputs: a 3 s
 * 9:16 clip with its own tone, and dubs shorter and longer than it.
 */

const FIXTURES = resolve(process.cwd(), "..", "..", "packages", "repurpose-contracts", "fixtures");
const PAYLOAD = JSON.parse(
  readFileSync(join(FIXTURES, "media-dub-payload.v1.json"), "utf8"),
) as DubPayload;
const RESULT = JSON.parse(
  readFileSync(join(FIXTURES, "media-dub-result.v1.json"), "utf8"),
) as Record<string, unknown>;
const WS = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

const CAN_RUN =
  spawnSync("ffmpeg", ["-version"], { stdio: "pipe", shell: true, timeout: 20_000 }).status === 0;
if (!CAN_RUN) console.warn("[dub.test] skipped — ffmpeg is not on PATH.");

function generate(args: readonly string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "pipe",
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.status !== 0) throw new Error(`fixture failed:\n${result.stderr ?? ""}`);
}

interface Streams {
  readonly video: { codec: string; width: number; height: number; durationMs: number } | null;
  readonly audio: { codec: string; durationMs: number } | null;
  readonly durationMs: number;
}

function streams(file: string): Streams {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", file],
    { stdio: "pipe", encoding: "utf8", timeout: 60_000 },
  );
  const parsed = JSON.parse(probe.stdout) as {
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      duration?: string;
    }[];
    format: { duration: string };
  };
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");
  const ms = (seconds: string | undefined): number => Math.round(Number(seconds ?? 0) * 1000);
  return {
    video:
      video === undefined
        ? null
        : {
            codec: video.codec_name,
            width: video.width ?? 0,
            height: video.height ?? 0,
            durationMs: ms(video.duration),
          },
    audio: audio === undefined ? null : { codec: audio.codec_name, durationMs: ms(audio.duration) },
    durationMs: ms(parsed.format.duration),
  };
}

let dir = "";
const files = new Map<string, string>();
const written = new Map<string, string>();

/** Keys resolve to local files; what is put is kept for the test to read. */
const store: ObjectStore = {
  bucket: "montaj-derived",
  kind: "r2",
  presignGet: async (key) => {
    const file = files.get(key);
    if (file === undefined) throw new Error(`no fixture for ${key}`);
    return file;
  },
  putFile: async ({ key, file }) => {
    const kept = join(dir, `kept-${String(written.size)}.mp4`);
    await copyFile(file, kept);
    written.set(key, kept);
    return 1;
  },
  putBody: async () => 0,
};

function contextFor(payload: DubPayload): JobContext {
  const settings = {
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    tempDir: undefined,
    sourceUrlTtlSeconds: 3_600,
    ffmpegTimeoutMs: 120_000,
  } as unknown as Settings;
  return {
    settings,
    envelope: {
      jobId: "01JCJ0B0000000000000000000",
      attemptId: "01JCATTEMPT000000000000000",
      workspaceId: WS,
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      priority: 3,
      jobKey: "media.dub:x",
      createdAt: "2026-10-04T00:00:00.000Z",
      payload: payload as never,
    },
    payload: payload as never,
    derivedPrefix: `ws/${WS}`,
    raw: store,
    derived: store,
    callbacks: {} as JobContext["callbacks"],
    report: () => undefined,
    signal: new AbortController().signal,
  };
}

const AUDIO_KEY = PAYLOAD.audio.key;
const VIDEO_KEY = PAYLOAD.video.key;
const SILENT_VIDEO_KEY = VIDEO_KEY.replace("master-4x5.mp4", "master-1x1.mp4");
const LONG_AUDIO_KEY = AUDIO_KEY.replace("audio.mp3", "audio.wav");

beforeAll(async () => {
  if (!CAN_RUN) return;
  dir = await mkdtemp(join(tmpdir(), "montaj-dub-test-"));
  const clip = join(dir, "clip.mp4");
  const silent = join(dir, "silent.mp4");
  const short = join(dir, "short.mp3");
  const long = join(dir, "long.wav");
  // The clip: 3 s of picture and its own 440 Hz sound.
  generate([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=180x320:rate=25:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    clip,
  ]);
  generate([
    "-f",
    "lavfi",
    "-i",
    "testsrc=size=180x320:rate=25:duration=3",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    silent,
  ]);
  // A dub shorter than the picture, and one longer.
  generate(["-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-c:a", "libmp3lame", short]);
  generate(["-f", "lavfi", "-i", "sine=frequency=660:duration=4", long]);
  files.set(VIDEO_KEY, clip);
  files.set(SILENT_VIDEO_KEY, silent);
  files.set(AUDIO_KEY, short);
  files.set(LONG_AUDIO_KEY, long);
}, 180_000);

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!CAN_RUN)("processDub with real ffmpeg", () => {
  it("copies the picture, pads a shorter dub with silence and cuts it to the picture", async () => {
    const outcome = await processDub(contextFor(PAYLOAD));
    const result = outcome.result as Record<string, unknown>;

    // The shape the API parses: the contract fixture's fields, no more.
    expect(Object.keys(result).sort()).toEqual(Object.keys(RESULT).sort());
    expect(result).toMatchObject({
      dubId: PAYLOAD.dubId,
      language: "hi-IN",
      shape: "4:5",
      key: PAYLOAD.destination.key,
      fit: "padded",
      mixed: false,
    });
    expect(result["adjustMs"]).toBeGreaterThan(800);
    expect(result["adjustMs"]).toBeLessThan(1_200);

    const made = streams(written.get(PAYLOAD.destination.key) ?? "");
    const source = streams(files.get(VIDEO_KEY) ?? "");
    // Stream-copied: same codec and size as the clean cut.
    expect(made.video).toMatchObject({ codec: "h264", width: 180, height: 320 });
    expect(made.video?.codec).toBe(source.video?.codec);
    expect(made.audio?.codec).toBe("aac");
    expect(Math.abs((made.audio?.durationMs ?? 0) - 3_000)).toBeLessThan(150);
    expect(Math.abs(made.durationMs - 3_000)).toBeLessThan(150);
    expect(result["durationMs"]).toBe(made.durationMs);
  }, 120_000);

  it("cuts a longer dub at the end of the picture", async () => {
    const payload = { ...PAYLOAD, audio: { key: LONG_AUDIO_KEY } };
    const result = (await processDub(contextFor(payload))).result as Record<string, unknown>;
    expect(result["fit"]).toBe("trimmed");
    const made = streams(written.get(PAYLOAD.destination.key) ?? "");
    expect(Math.abs((made.audio?.durationMs ?? 0) - 3_000)).toBeLessThan(150);
  }, 120_000);

  it("keeps the clip's own sound under the dub only when asked, and only when it has one", async () => {
    const mixed = (await processDub(contextFor({ ...PAYLOAD, originalBedDb: -18 })))
      .result as Record<string, unknown>;
    expect(mixed["mixed"]).toBe(true);
    expect(streams(written.get(PAYLOAD.destination.key) ?? "").audio).not.toBeNull();

    const silentPayload: DubPayload = {
      ...PAYLOAD,
      shape: "1:1",
      video: { key: SILENT_VIDEO_KEY, durationMs: 3_000 },
      destination: { bucket: "r2", key: PAYLOAD.destination.key.replace("4x5.mp4", "1x1.mp4") },
      originalBedDb: -18,
    };
    const replaced = (await processDub(contextFor(silentPayload))).result as Record<
      string,
      unknown
    >;
    expect(replaced["mixed"]).toBe(false);
    expect(streams(written.get(silentPayload.destination.key) ?? "").audio?.codec).toBe("aac");
  }, 120_000);
});

describe("checkPayload", () => {
  it("takes the contract's own fixture", () => {
    expect(checkPayload(PAYLOAD, WS)).toEqual({ language: "hi-IN" });
  });

  const other = "01JCWS0000000000000000000B";
  it.each([
    ["another workspace", PAYLOAD, other],
    [
      "a captioned export as the picture",
      {
        ...PAYLOAD,
        video: {
          key: `ws/${WS}/p/01ARZ3NDEKTSV4RRFFQ69G5FAX/exports/01JCEXP0RT0000000000000000.mp4`,
          durationMs: 3_000,
        },
      },
      WS,
    ],
    ["another dub's audio", { ...PAYLOAD, dubId: "01JCDVB000000000000000000Z" }, WS],
    ["another language", { ...PAYLOAD, language: "ta-IN" }, WS],
    ["the destination of another shape", { ...PAYLOAD, shape: "9:16" }, WS],
    ["a louder original", { ...PAYLOAD, originalBedDb: 6 }, WS],
    ["no picture length", { ...PAYLOAD, video: { key: PAYLOAD.video.key, durationMs: 0 } }, WS],
  ] as const)("refuses %s, for good", (_name, payload, workspace) => {
    try {
      checkPayload(payload as DubPayload, workspace);
      expect.unreachable("the payload should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MediaJobError);
      expect((error as MediaJobError).retryable).toBe(false);
    }
  });
});

describe("fitOf", () => {
  it("names how the dub meets the picture", () => {
    expect(fitOf(3_000, 3_020)).toEqual({ fit: "exact", adjustMs: 20 });
    expect(fitOf(2_000, 3_000)).toEqual({ fit: "padded", adjustMs: 1_000 });
    expect(fitOf(3_500, 3_000)).toEqual({ fit: "trimmed", adjustMs: 500 });
  });
});

describe("muxArgs", () => {
  it("stream-copies the picture and ends at its length", () => {
    const args = muxArgs({
      videoUrl: "v.mp4",
      audioUrl: "a.mp3",
      durationMs: 34_000,
      out: "o.mp4",
    });
    expect(args).toContain("copy");
    expect(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2)).toEqual(["-t", "34.000"]);
    expect(args.join(" ")).toContain("-af apad");
    expect(args.join(" ")).not.toContain("amix");
  });

  it("lays the dub over the clip's own sound when asked", () => {
    const args = muxArgs({
      videoUrl: "v.mp4",
      audioUrl: "a.mp3",
      durationMs: 1_000,
      bedDb: -18,
      out: "o.mp4",
    });
    expect(args.join(" ")).toContain("volume=-18.0dB");
    expect(args.join(" ")).toContain("amix=inputs=2:duration=first");
  });
});
