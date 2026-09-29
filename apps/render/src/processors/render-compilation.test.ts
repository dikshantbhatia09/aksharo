/**
 * The `render.compilation` processor (2026-10-03): the wiring between a BullMQ
 * job and the join, and when a failure is reported.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { UnrecoverableError } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyCompilationError, processRenderCompilation } from "./render-compilation.js";
import { CallbackClient, type FetchLike } from "../callbacks.js";
import { CompilationError } from "../compilation/join.js";
import { StorageError } from "../storage.js";
import {
  createDirectoryStore,
  makeSyntheticClip,
  removeQuietly,
  type DirectoryStore,
} from "../testing.js";

import type { Job } from "bullmq";

const WS = "01JCWS0000000000000000000A";
const PROJECT = "01JCSRCPR0JECT000000000000";
const EXPORT = "01JCEXP0RT0000000000000000";

let scratch: string;
let store: DirectoryStore;
const keys: string[] = [];

interface RecordedCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function recorder(): { calls: RecordedCall[]; callbacks: CallbackClient } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({ status: 200, text: () => Promise.resolve('{"applied":true}') });
  };
  return {
    calls,
    callbacks: new CallbackClient({ apiOrigin: "http://api.test", secret: "s", fetch }),
  };
}

function fakeJob(payload: unknown, attemptsMade = 0): Job {
  return {
    id: "bull-9",
    queueName: "render.compilation",
    attemptsMade,
    opts: { attempts: 2 },
    data: {
      jobId: "01JA20JOB000000000000000AB",
      attemptId: "01JA20ATTEMPT00000000000AB",
      workspaceId: WS,
      projectId: PROJECT,
      priority: 3,
      jobKey: `render.compilation:x:${EXPORT}`,
      createdAt: new Date().toISOString(),
      payload,
    },
    updateProgress: () => Promise.resolve(),
  } as unknown as Job;
}

function payload(clipKeys: readonly string[] = keys): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: "01JCRN0000000000000000000A",
    compilationId: "01JCC0MP11AT10N00000000000",
    exportId: EXPORT,
    projectId: PROJECT,
    shape: "1:1",
    width: 1080,
    height: 1080,
    fps: 30,
    fadeMs: 500,
    clips: clipKeys.map((key, index) => ({
      clipId: `01JCC11P00000000000000000${String(index)}`,
      key,
      durationMs: 1_000,
    })),
  };
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "compilation-processor-"));
  store = createDirectoryStore(join(scratch, "store"));
  for (const index of [1, 2]) {
    const path = join(scratch, `clip-${String(index)}.mp4`);
    await makeSyntheticClip(path, { seconds: 1, width: 1080, height: 1080, fps: 30 });
    const key = `ws/${WS}/p/01JCC11PPR0JECT0000000000${String(index)}/exports/01JCEXP0RTA00000000000000${String(index)}.mp4`;
    await store.seed(key, path);
    keys.push(key);
  }
}, 180_000);

afterAll(async () => {
  await removeQuietly(scratch);
});

/** The directory store, answering a missing object the way the S3 store does. */
function s3Like(): DirectoryStore {
  return {
    ...store,
    download: async (key, destination) => {
      try {
        return await store.download(key, destination);
      } catch (error) {
        throw new StorageError(
          "storage/unreadable",
          `could not read ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

function context(callbacks: CallbackClient) {
  return {
    dependencies: { derivedStore: s3Like(), workDir: scratch, encoderThreads: 2 },
    callbacks,
    progressIntervalMs: 1_000,
  };
}

describe("processRenderCompilation", () => {
  it("joins the clips and reports what it made, with the cloud render's usage", async () => {
    const { calls, callbacks } = recorder();
    const result = await processRenderCompilation(fakeJob(payload()), context(callbacks));

    expect(result).toMatchObject({
      exportId: EXPORT,
      outputKey: `ws/${WS}/p/${PROJECT}/exports/${EXPORT}.mp4`,
      width: 1080,
      height: 1080,
      clips: 2,
      intro: false,
    });
    // Two 30-frame clips and one 15-frame fade: 45 frames, 1.5 s.
    expect(result.outputMs).toBe(1_500);
    expect(calls[0]?.url).toContain("/progress");
    const completion = calls.at(-1);
    expect(completion?.url).toContain("/complete");
    expect(completion?.body).toMatchObject({
      status: "succeeded",
      result: { outputMs: 1_500, clips: 2 },
      usage: { outputSeconds: 1.5, provider: "self" },
    });
  }, 180_000);

  it("refuses a payload that does not parse, once, and is not retried", async () => {
    const { calls, callbacks } = recorder();
    await expect(
      processRenderCompilation(fakeJob({ ...payload(), width: 720 }), context(callbacks)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(calls.at(-1)?.body).toMatchObject({
      status: "failed",
      error: { code: "render/bad-payload", retryable: false },
      finalAttempt: true,
    });
  });

  it("refuses a clip of another workspace without reading it", async () => {
    const { calls, callbacks } = recorder();
    const stranger = (keys[0] ?? "").replace(WS, "01JCWS0000000000000000000B");
    await expect(
      processRenderCompilation(fakeJob(payload([stranger, keys[1] ?? ""])), context(callbacks)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(calls.at(-1)?.body).toMatchObject({
      status: "failed",
      error: { code: "storage/bad-key", retryable: false },
    });
  });

  it("says nothing on a first attempt that may yet succeed, and reports the last", async () => {
    const gone = `ws/${WS}/p/01JCC11PPR0JECT00000000009/exports/01JCEXP0RTA000000000000009.mp4`;
    const first = recorder();
    await expect(
      processRenderCompilation(
        fakeJob(payload([keys[0] ?? "", gone]), 0),
        context(first.callbacks),
      ),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(first.calls.filter((call) => call.url.includes("/complete"))).toEqual([]);

    const last = recorder();
    await expect(
      processRenderCompilation(fakeJob(payload([keys[0] ?? "", gone]), 1), context(last.callbacks)),
    ).rejects.toThrow();
    expect(last.calls.at(-1)?.body).toMatchObject({
      status: "failed",
      error: { code: "storage/unreadable", retryable: true },
      finalAttempt: true,
    });
  });
});

describe("classifyCompilationError", () => {
  it("never retries what would fail the same way", () => {
    expect(
      classifyCompilationError(new CompilationError("render/compilation-too-long", "x")),
    ).toMatchObject({ retryable: false });
    expect(
      classifyCompilationError(new CompilationError("render/no-video-stream", "x")),
    ).toMatchObject({ retryable: false });
    expect(classifyCompilationError(new StorageError("storage/bad-key", "x"))).toMatchObject({
      retryable: false,
    });
  });

  it("retries a store or an encoder that failed", () => {
    expect(classifyCompilationError(new StorageError("storage/unreadable", "x"))).toMatchObject({
      code: "storage/unreadable",
      retryable: true,
    });
    expect(classifyCompilationError(new Error("boom"))).toMatchObject({
      code: "render/failed",
      retryable: true,
    });
  });
});
