import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { Worker } from "bullmq";
import { config as loadDotenvFile } from "dotenv";
import IORedis from "ioredis";

import { loadEnv } from "@montaj/config";

import { logger } from "./logger.js";
import { processRenderVideo } from "./processors/render-video.js";
import { RENDER_VIDEO_QUEUE } from "./queues.js";

/** Renders are CPU-bound; A20 sizes this against the render node. */
const CONCURRENCY = Number(process.env["RENDER_CONCURRENCY"] ?? 1) || 1;

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

  // BullMQ blocks on Redis, so retries-per-request must be disabled.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker(RENDER_VIDEO_QUEUE, processRenderVideo, {
    connection,
    concurrency: CONCURRENCY,
  });

  worker.on("ready", () => {
    logger.info(`render ready — waiting for jobs on ${RENDER_VIDEO_QUEUE}`, {
      queue: RENDER_VIDEO_QUEUE,
      concurrency: CONCURRENCY,
    });
  });
  worker.on("failed", (job, error) => {
    logger.error("job failed", { bullJobId: job?.id, error: error.message });
  });
  worker.on("error", (error) => {
    logger.error("worker error", { error: error.message });
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info("shutting down", { signal });
    void worker
      .close()
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
