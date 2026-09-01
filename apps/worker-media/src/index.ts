import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { Worker } from "bullmq";
import { config as loadDotenvFile } from "dotenv";
import IORedis from "ioredis";

import { loadEnv } from "@montaj/config";

import { logger } from "./logger.js";
import { assertMediaToolsAvailable } from "./media-tools.js";
import { processProbe } from "./processors/probe.js";
import { MEDIA_PROBE_QUEUE } from "./queues.js";

/** How many probes run at once. A07 tunes this against the media node's cores. */
const CONCURRENCY = Number(process.env["WORKER_MEDIA_CONCURRENCY"] ?? 2) || 2;

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

  // Boot check before touching Redis: a worker with no FFmpeg would take jobs it
  // cannot finish, so it must refuse to start at all.
  const tools = await assertMediaToolsAvailable();
  for (const { tool, version } of tools) logger.info("media tool available", { tool, version });

  // BullMQ requires blocking commands, so retries-per-request must be disabled.
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const worker = new Worker(MEDIA_PROBE_QUEUE, processProbe, {
    connection,
    concurrency: CONCURRENCY,
  });

  worker.on("ready", () => {
    logger.info(`worker-media ready — waiting for jobs on ${MEDIA_PROBE_QUEUE}`, {
      queue: MEDIA_PROBE_QUEUE,
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
    // `close()` waits for in-flight jobs so a rolling deploy never orphans one.
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
