/**
 * The two processors: the wiring between a BullMQ job and the render, and the
 * one decision they own — whether a failure is worth retrying.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  RenderManifestError,
  type SubtitleFormat,
  type SubtitleScript,
} from "@montaj/render-manifest";

import { CallbackClient, type FetchLike } from "../callbacks.js";
import { processRenderSubtitle } from "./render-subtitle.js";
import { classifyError, processRenderVideo } from "./render-video.js";
import { rawKey } from "../storage.js";
import {
  createDirectoryStore,
  FIXTURE_IDS,
  makeSyntheticClip,
  removeQuietly,
  samplePayload,
  sampleProjection,
  signedFixtureManifest,
  type DirectoryStore,
} from "../testing.js";

import type { Job } from "bullmq";

const SECRET = "processor-secret";
const WIDTH = 270;
const HEIGHT = 480;
const FPS = 8;

let scratch: string;
let rawStore: DirectoryStore;
let derivedStore: DirectoryStore;
let sourceKey: string;

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function callbackRecorder(): { calls: RecordedCall[]; callbacks: CallbackClient } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({ status: 200, text: () => Promise.resolve('{"applied":true}') });
  };
  return {
    calls,
    callbacks: new CallbackClient({ apiOrigin: "http://api.test", secret: SECRET, fetch }),
  };
}

/** The slice of a BullMQ job the processors touch. */
function fakeJob(payload: unknown, attemptsMade = 0): Job {
  const progress: number[] = [];
  return {
    id: "bull-1",
    queueName: "render.video",
    attemptsMade,
    opts: { attempts: 2 },
    data: {
      jobId: "01JA20JOB000000000000000AA",
      attemptId: "01JA20ATTEMPT00000000000AA",
      workspaceId: FIXTURE_IDS.workspaceId,
      projectId: FIXTURE_IDS.projectId,
      priority: 3,
      jobKey: "render.video:x",
      createdAt: new Date().toISOString(),
      payload,
    },
    updateProgress: (value: number) => {
      progress.push(value);
      return Promise.resolve();
    },
  } as unknown as Job;
}

/**
 * The fixture's default issue time is a fixed date; these tests run against the
 * real clock, so every manifest is signed at `Date.now()` instead.
 */
function signed(
  extra: Parameters<typeof signedFixtureManifest>[1] = {},
): ReturnType<typeof signedFixtureManifest> {
  return signedFixtureManifest(SECRET, extra, Date.now());
}

function overrides(): Parameters<typeof signedFixtureManifest>[1] {
  return {
    source: {
      mediaId: FIXTURE_IDS.mediaId,
      bucket: "raw",
      key: sourceKey,
      durationMs: 3_000,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
    },
    timemap: { sourceDurationMs: 3_000, edits: [], snapCutsToFrames: false },
    output: {
      kind: "video",
      preset: "custom",
      aspect: "9:16",
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      container: "mp4",
      videoCodec: "h264",
      crf: 32,
      encoderPreset: "ultrafast",
    },
    watermark: null,
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "a20-processors-"));
  rawStore = createDirectoryStore(join(scratch, "raw"));
  derivedStore = createDirectoryStore(join(scratch, "derived"));
  const clip = join(scratch, "clip.mp4");
  await makeSyntheticClip(clip, { seconds: 3, width: WIDTH, height: HEIGHT, fps: FPS });
  sourceKey = rawKey(FIXTURE_IDS.workspaceId, FIXTURE_IDS.projectId, FIXTURE_IDS.mediaId, "mp4");
  await rawStore.seed(sourceKey, clip);
}, 300_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

describe("classifying a failure", () => {
  it("never retries a manifest that will never verify", () => {
    for (const code of [
      "manifest/bad-signature",
      "manifest/expired",
      "manifest/caps-exceeded",
      "manifest/malformed",
    ] as const) {
      const classified = classifyError(new RenderManifestError(code, "no"));
      expect(classified).toMatchObject({ code, retryable: false });
    }
  });

  it("never retries a payload the producer got wrong", () => {
    for (const code of [
      "render/bad-style",
      "render/bad-projection",
      "render/unsupported-output",
      "storage/bad-key",
    ]) {
      expect(classifyError(Object.assign(new Error("x"), { code })).retryable).toBe(false);
    }
  });

  it("retries something that might work next time", () => {
    expect(classifyError(new Error("socket hang up"))).toEqual({
      code: "render/failed",
      message: "socket hang up",
      retryable: true,
    });
    expect(
      classifyError(Object.assign(new Error("x"), { code: "storage/unreadable" })).retryable,
    ).toBe(true);
  });

  it("copes with something that is not an Error at all", () => {
    expect(classifyError("just a string").message).toBe("just a string");
  });
});

describe("the render.video processor", () => {
  it("renders, reports usage, and completes over the signed callback", async () => {
    const { calls, callbacks } = callbackRecorder();
    const payload = await samplePayload(SECRET, overrides(), 3_000);
    const result = await processRenderVideo(fakeJob(payload), {
      dependencies: {
        rawStore,
        derivedStore,
        secret: SECRET,
        encoder: "libx264",
        workDir: scratch,
      },
      callbacks,
      progressIntervalMs: 50,
    });

    expect(result.outputKey).toContain("/exports/");
    expect(result.watermarked).toBe(false);
    expect(result.framesRendered).toBeLessThanOrEqual(result.frames);

    const completion = calls.find((call) => call.url.endsWith("/complete"));
    expect(completion?.body["status"]).toBe("succeeded");
    const usage = completion?.body["usage"] as Record<string, unknown>;
    expect(usage["outputSeconds"]).toBe(3);
    // R2 charges nothing for egress (D35); saying zero is not the same as
    // leaving it out.
    expect(usage["egressBytes"]).toBe(0);
    expect(calls.some((call) => call.url.endsWith("/progress"))).toBe(true);
  }, 600_000);

  it("completes with a non-retryable failure when the manifest does not verify", async () => {
    const { calls, callbacks } = callbackRecorder();
    const payload = await samplePayload("wrong secret", overrides(), 3_000);
    await expect(
      processRenderVideo(fakeJob(payload), {
        dependencies: {
          rawStore,
          derivedStore,
          secret: SECRET,
          encoder: "libx264",
          workDir: scratch,
        },
        callbacks,
        progressIntervalMs: 50,
      }),
    ).rejects.toThrow(RenderManifestError);

    const completion = calls.find((call) => call.url.endsWith("/complete"));
    expect(completion?.body["status"]).toBe("failed");
    expect(completion?.body["error"]).toMatchObject({
      code: "manifest/bad-signature",
      retryable: false,
    });
    // A refusal that cannot succeed on a retry is a final attempt whatever
    // BullMQ's counter says, so it reaches the dead-letter table at once.
    expect(completion?.body["finalAttempt"]).toBe(true);
  }, 300_000);

  it("refuses the ass path, which A18a owns", async () => {
    const { calls, callbacks } = callbackRecorder();
    const payload = { ...(await samplePayload(SECRET, overrides(), 3_000)), path: "ass" as const };
    await expect(
      processRenderVideo(fakeJob(payload), {
        dependencies: {
          rawStore,
          derivedStore,
          secret: SECRET,
          encoder: "libx264",
          workDir: scratch,
        },
        callbacks,
        progressIntervalMs: 50,
      }),
    ).rejects.toThrow(/ass-exporter/);
    expect(calls.find((call) => call.url.endsWith("/complete"))?.body["error"]).toMatchObject({
      code: "render/unsupported-output",
      retryable: false,
    });
  }, 120_000);

  it("refuses job data that is not the CONTRACTS §3 envelope", async () => {
    const { callbacks } = callbackRecorder();
    const job = { id: "x", queueName: "render.video", data: { nope: true } } as unknown as Job;
    await expect(
      processRenderVideo(job, {
        dependencies: {
          rawStore,
          derivedStore,
          secret: SECRET,
          encoder: "libx264",
        },
        callbacks,
        progressIntervalMs: 50,
      }),
    ).rejects.toThrow(/envelope/);
  });
});

describe("the render.subtitle processor", () => {
  // Ten seconds, not three: the sample project's first caption runs to 5.2 s, so
  // a three-second window has no whole segment in it and every sidecar would be
  // an empty file that proved nothing.
  const SUBTITLE_MS = 10_000;
  const subtitleOverrides = () => ({
    ...overrides(),
    timemap: { sourceDurationMs: SUBTITLE_MS, edits: [], snapCutsToFrames: false },
    subtitles: {
      formats: ["srt", "vtt"] as SubtitleFormat[],
      scripts: ["roman"] as SubtitleScript[],
      dropFillers: false,
    },
  });

  it("writes one sidecar per format and script, under the export prefix", async () => {
    const { calls, callbacks } = callbackRecorder();
    const payload = {
      manifest: signed(subtitleOverrides()),
      projection: await sampleProjection(SUBTITLE_MS),
    };
    const result = await processRenderSubtitle(fakeJob(payload), {
      derivedStore,
      callbacks,
      secret: SECRET,
    });

    expect(result.sidecars).toHaveLength(2);
    expect(result.sidecars.map((entry) => entry.format).sort()).toEqual(["srt", "vtt"]);
    for (const sidecar of result.sidecars) {
      expect(sidecar.key).toContain(`/exports/${FIXTURE_IDS.exportId}.roman.`);
      expect(sidecar.sizeBytes).toBeGreaterThan(0);
    }

    const srt = await derivedStore.read(
      result.sidecars.find((entry) => entry.format === "srt")?.key ?? "",
    );
    expect(srt.toString("utf8")).toContain("-->");
    expect(calls.find((call) => call.url.endsWith("/complete"))?.body["status"]).toBe("succeeded");
  }, 120_000);

  it("remaps the cues through the timemap, so they match the burned-in captions", async () => {
    const { callbacks } = callbackRecorder();
    const payload = {
      manifest: signed({
        ...subtitleOverrides(),
        timemap: {
          sourceDurationMs: SUBTITLE_MS,
          snapCutsToFrames: false,
          edits: [{ kind: "cut", startMs: 0, endMs: 1_000 }],
        },
      }),
      projection: await sampleProjection(SUBTITLE_MS),
    };
    const result = await processRenderSubtitle(fakeJob(payload), {
      derivedStore,
      callbacks,
      secret: SECRET,
    });
    expect(result.outputMs).toBe(SUBTITLE_MS - 1_000);
    const srt = (
      await derivedStore.read(result.sidecars.find((entry) => entry.format === "srt")?.key ?? "")
    ).toString("utf8");
    // The first caption runs 320–5,200 ms in the source; with the first second
    // cut it must now start at 0 and end a second earlier than it did.
    expect(srt).toContain("00:00:00,000 --> 00:00:04,200");
  }, 120_000);

  it("refuses a manifest that asks for no sidecars", async () => {
    const { calls, callbacks } = callbackRecorder();
    const payload = {
      manifest: signed({ ...overrides(), subtitles: null }),
      projection: await sampleProjection(SUBTITLE_MS),
    };
    await expect(
      processRenderSubtitle(fakeJob(payload), { derivedStore, callbacks, secret: SECRET }),
    ).rejects.toThrow(/needs a subtitles block/);
    expect(calls.find((call) => call.url.endsWith("/complete"))?.body["error"]).toMatchObject({
      retryable: false,
    });
  }, 120_000);

  it("refuses an ASS sidecar until A18a lands", async () => {
    const { callbacks } = callbackRecorder();
    const payload = {
      manifest: signed({
        ...overrides(),
        subtitles: {
          formats: ["ass"] as SubtitleFormat[],
          scripts: ["roman"] as SubtitleScript[],
          dropFillers: false,
        },
      }),
      projection: await sampleProjection(SUBTITLE_MS),
    };
    await expect(
      processRenderSubtitle(fakeJob(payload), { derivedStore, callbacks, secret: SECRET }),
    ).rejects.toThrow(/A18a/);
  }, 120_000);

  it("refuses a manifest that does not verify", async () => {
    const { callbacks } = callbackRecorder();
    const payload = {
      manifest: signedFixtureManifest("another secret", subtitleOverrides(), Date.now()),
      projection: await sampleProjection(SUBTITLE_MS),
    };
    await expect(
      processRenderSubtitle(fakeJob(payload), { derivedStore, callbacks, secret: SECRET }),
    ).rejects.toThrow(RenderManifestError);
  }, 120_000);

  it("refuses job data that is not the CONTRACTS §3 envelope", async () => {
    const { callbacks } = callbackRecorder();
    const job = { id: "x", queueName: "render.subtitle", data: 42 } as unknown as Job;
    await expect(
      processRenderSubtitle(job, { derivedStore, callbacks, secret: SECRET }),
    ).rejects.toThrow(/envelope/);
  });
});
