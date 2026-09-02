import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONCURRENCY,
  FFMPEG_TIMEOUT_MS,
  SOURCE_URL_TTL_SECONDS,
  queuePrefix,
  resolveSettings,
} from "./settings.js";

/** A complete CONTRACTS §1 environment, so `loadEnv()` is satisfied. */
const ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgresql://montaj:montaj@localhost:5432/montaj_test?schema=public",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "ap-south-1",
  S3_BUCKET_RAW: "montaj-raw",
  S3_ACCESS_KEY: "montaj-local",
  S3_SECRET_KEY: "montaj-local-secret",
  R2_ENDPOINT: "http://localhost:9000",
  R2_BUCKET_DERIVED: "montaj-derived",
  R2_ACCESS_KEY: "montaj-local",
  R2_SECRET_KEY: "montaj-local-secret",
  JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----\\n",
  JWT_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\\ntest\\n-----END PUBLIC KEY-----\\n",
  INTERNAL_CALLBACK_SECRET: "test-callback-secret-at-least-32-characters-long",
  WEB_ORIGIN: "http://localhost:3000",
  API_ORIGIN: "http://localhost:3001",
  LLM_PROVIDER: "mock",
  GPU_PROVIDER: "none",
  FEATURE_FLAGS_JSON: "{}",
  MAIL_PROVIDER: "dev",
};

describe("resolveSettings", () => {
  it("consumes both media queues by default", () => {
    expect(resolveSettings(ENV).queues).toEqual(["media.probe", "media.proxy"]);
  });

  it("lets a pod be pinned to one queue", () => {
    // A CPU pool takes probes while a bigger pool takes the transcodes.
    expect(resolveSettings({ ...ENV, WORKER_MEDIA_QUEUES: "media.proxy" }).queues).toEqual([
      "media.proxy",
    ]);
    expect(
      resolveSettings({ ...ENV, WORKER_MEDIA_QUEUES: " media.probe , media.proxy " }).queues,
    ).toEqual(["media.probe", "media.proxy"]);
  });

  it("refuses a queue this worker does not own, rather than ignoring it", () => {
    // A pod pinned to a queue nothing consumes looks healthy and does nothing.
    expect(() => resolveSettings({ ...ENV, WORKER_MEDIA_QUEUES: "ai.transcribe" })).toThrow(
      /does not own/,
    );
  });

  it("takes the defaults when nothing is configured", () => {
    const settings = resolveSettings(ENV);
    expect(settings.concurrency).toBe(DEFAULT_CONCURRENCY);
    expect(settings.queuePrefix).toBe("bull");
    expect(settings.ffmpegPath).toBe("ffmpeg");
    expect(settings.ffprobePath).toBe("ffprobe");
    expect(settings.sourceUrlTtlSeconds).toBe(SOURCE_URL_TTL_SECONDS);
    expect(settings.ffmpegTimeoutMs).toBe(FFMPEG_TIMEOUT_MS);
    expect(settings.loudnessEnabled).toBe(true);
    expect(settings.tempDir).toBeUndefined();
  });

  it("reads the deployment tuning", () => {
    const settings = resolveSettings({
      ...ENV,
      WORKER_MEDIA_CONCURRENCY: "6",
      MONTAJ_QUEUE_PREFIX: "a07",
      FFMPEG_PATH: "/opt/ffmpeg/bin/ffmpeg",
      FFPROBE_PATH: "/opt/ffmpeg/bin/ffprobe",
      WORKER_MEDIA_TEMP_DIR: "/mnt/scratch",
      WORKER_MEDIA_LOUDNESS: "0",
    });
    expect(settings.concurrency).toBe(6);
    expect(settings.queuePrefix).toBe("a07");
    expect(settings.ffmpegPath).toBe("/opt/ffmpeg/bin/ffmpeg");
    expect(settings.tempDir).toBe("/mnt/scratch");
    expect(settings.loudnessEnabled).toBe(false);
  });

  it("falls back rather than taking a nonsense number", () => {
    for (const value of ["0", "-4", "banana", ""]) {
      expect(resolveSettings({ ...ENV, WORKER_MEDIA_CONCURRENCY: value }).concurrency).toBe(
        DEFAULT_CONCURRENCY,
      );
    }
  });

  it("fails fast on an incomplete environment (CONTRACTS §1)", () => {
    const { S3_BUCKET_RAW: _dropped, ...missing } = ENV;
    expect(() => resolveSettings(missing)).toThrow(/S3_BUCKET_RAW/);
  });
});

describe("queuePrefix", () => {
  it("defaults to BullMQ's own prefix, which is what the API produces onto", () => {
    // A mismatch here is silent: the producer writes keys nothing ever reads.
    expect(queuePrefix({})).toBe("bull");
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "" })).toBe("bull");
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "   " })).toBe("bull");
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "a07" })).toBe("a07");
  });
});
