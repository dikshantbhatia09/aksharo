import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONCURRENCY,
  FFMPEG_TIMEOUT_MS,
  SOURCE_URL_TTL_SECONDS,
  findExecutable,
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
  it("consumes every implemented media queue by default", () => {
    expect(resolveSettings(ENV).queues).toEqual([
      "media.acquire",
      "media.probe",
      "media.proxy",
      "media.clip",
    ]);
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

  it("keeps the downloader's version pin unless a deployment lets it go by name", () => {
    // WORKER_MEDIA_YT_DLP_VERIFY=0 alone is "no digest to check", not "any version".
    expect(resolveSettings({ ...ENV, WORKER_MEDIA_YT_DLP_VERIFY: "0" }).ytDlpAllowUnpinned).toBe(
      false,
    );
    for (const value of ["true", "yes", "0", ""]) {
      expect(
        resolveSettings({ ...ENV, WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED: value }).ytDlpAllowUnpinned,
        value,
      ).toBe(false);
    }
    expect(
      resolveSettings({ ...ENV, WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED: "1" }).ytDlpAllowUnpinned,
    ).toBe(true);
  });

  it("resolves a configured ffmpeg path to itself, for yt-dlp's merge", () => {
    expect(
      resolveSettings({ ...ENV, FFMPEG_PATH: "/opt/ffmpeg/bin/ffmpeg" }).ffmpegLocation,
    ).toBe("/opt/ffmpeg/bin/ffmpeg");
  });
});

describe("findExecutable", () => {
  let dir: string;
  let empty: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "montaj-path-test-"));
    empty = await mkdtemp(join(tmpdir(), "montaj-path-empty-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  });

  it("finds a bare Windows name the way spawn does: .com, then .exe, down PATH", async () => {
    // The default FFMPEG_PATH is `ffmpeg`, which yt-dlp takes for a file that
    // does not exist; production's merge ffmpeg has to be found as a file.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own temp directory
    await writeFile(join(dir, "ffmpeg.exe"), "");
    const found = findExecutable("ffmpeg", {
      env: { Path: `${empty};"${dir}"` },
      platform: "win32",
      cwd: empty,
    });
    expect(found).toBe(join(dir, "ffmpeg.exe"));
  });

  it("returns a name with a path in it as it is, and nothing for a name on no PATH", () => {
    expect(findExecutable("C:/tools/ffmpeg.exe", { env: {} })).toBe("C:/tools/ffmpeg.exe");
    expect(
      findExecutable("ffmpeg", { env: { PATH: empty }, platform: "win32", cwd: empty }),
    ).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "needs the execute bit elsewhere, as execvp does",
    async () => {
      const path = join(dir, "ffmpeg");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- this test's own temp directory
      await writeFile(path, "");
      expect(findExecutable("ffmpeg", { env: { PATH: dir }, platform: "linux" })).toBeUndefined();
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- as above
      await chmod(path, 0o755);
      expect(findExecutable("ffmpeg", { env: { PATH: `${empty}:${dir}` }, platform: "linux" })).toBe(
        path,
      );
    },
  );
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
