import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { Worker } from "bullmq";
import { config as loadDotenvFile } from "dotenv";
import IORedis from "ioredis";

import { loadEnv } from "@montaj/config";

import { CallbackClient } from "./callbacks.js";
import { loadRenderSettings } from "./config.js";
import { assertMediaToolsAvailable } from "./ffmpeg/tools.js";
import { logger } from "./logger.js";
import { workerOptions } from "./policies.js";
import { processRenderSubtitle } from "./processors/render-subtitle.js";
import { processRenderVideo } from "./processors/render-video.js";
import { RENDER_SUBTITLE_QUEUE, RENDER_VIDEO_QUEUE } from "./queues.js";
import { createObjectStore } from "./storage.js";

/** Load the nearest `.env` walking up to the repo root; real env vars win. */
function loadRepoDotenv(startDir: string = process.cwd()): void {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      loadDotenvFile({ path: candidate, override: false, quiet: true });
      return;
    }
    if (dir === root) return;
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function main(): Promise<void> {
  loadRepoDotenv();
  const env = loadEnv();
  const settings = loadRenderSettings();

  // Fail on boot, not one job at a time: a render node with no ffmpeg cannot do
  // anything useful and should not take work off the queue.
  const tools = await assertMediaToolsAvailable();

  // BullMQ blocks on Redis, so retries-per-request must be disabled.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const [rawStore, derivedStore] = await Promise.all([
    createObjectStore({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET_RAW,
      accessKey: env.S3_ACCESS_KEY,
      secretKey: env.S3_SECRET_KEY,
    }),
    createObjectStore({
      endpoint: env.R2_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.R2_BUCKET_DERIVED,
      accessKey: env.R2_ACCESS_KEY,
      secretKey: env.R2_SECRET_KEY,
    }),
  ]);

  const callbacks = new CallbackClient({
    apiOrigin: env.API_ORIGIN,
    secret: env.INTERNAL_CALLBACK_SECRET,
  });

  const dependencies = {
    rawStore,
    derivedStore,
    secret: env.INTERNAL_CALLBACK_SECRET,
    secretNext: env.INTERNAL_CALLBACK_SECRET_NEXT,
    encoder: settings.encoder,
    fontDir: settings.fontDir,
    workDir: settings.workDir,
    ffmpegLogLevel: settings.logLevel,
  };

  const shared = {
    connection,
    prefix: settings.queuePrefix,
    concurrency: settings.concurrency,
  };

  const video = new Worker(
    RENDER_VIDEO_QUEUE,
    (job) =>
      processRenderVideo(job, {
        dependencies,
        callbacks,
        progressIntervalMs: settings.progressIntervalMs,
      }),
    { ...shared, ...workerOptions(RENDER_VIDEO_QUEUE) },
  );

  const subtitle = new Worker(
    RENDER_SUBTITLE_QUEUE,
    (job) =>
      processRenderSubtitle(job, {
        derivedStore,
        callbacks,
        secret: env.INTERNAL_CALLBACK_SECRET,
        secretNext: env.INTERNAL_CALLBACK_SECRET_NEXT,
      }),
    // Sidecars are text: the video queue's ten-minute lock would just delay
    // noticing a dead worker, so this one keeps the family default.
    { ...shared, ...workerOptions(RENDER_SUBTITLE_QUEUE) },
  );

  for (const worker of [video, subtitle]) {
    worker.on("ready", () => {
      logger.info(`render ready — waiting for jobs on ${worker.name}`, {
        queue: worker.name,
        concurrency: settings.concurrency,
        prefix: settings.queuePrefix,
        encoder: settings.encoder,
        fontDir: settings.fontDir ?? "(bundled subsets)",
        ffmpeg: tools.find((tool) => tool.tool === "ffmpeg")?.version,
      });
    });
    worker.on("failed", (job, error) => {
      logger.error("job failed", { queue: worker.name, bullJobId: job?.id, error: error.message });
    });
    worker.on("error", (error) => {
      logger.error("worker error", { queue: worker.name, error: error.message });
    });
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info("shutting down", { signal });
    void Promise.all([video.close(), subtitle.close()])
      .then(() => connection.quit())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
