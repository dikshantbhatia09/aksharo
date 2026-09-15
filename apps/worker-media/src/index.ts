import { Worker } from "bullmq";
import IORedis from "ioredis";

import { logger } from "./logger.js";
import { assertMediaToolsAvailable } from "./media-tools.js";
import { workerOptions } from "./policies.js";
import { processAcquire } from "./processors/acquire.js";
import { processProbe } from "./processors/probe.js";
import { processProxy } from "./processors/proxy.js";
import { MEDIA_ACQUIRE_QUEUE, MEDIA_PROBE_QUEUE, MEDIA_PROXY_QUEUE } from "./queues.js";
import { buildServices, makeHandler } from "./runtime.js";
import { loadRepoDotenv, resolveSettings } from "./settings.js";
import { assertYtDlpUsable } from "./yt-dlp.js";

import type { MediaQueue } from "./queues.js";
import type { Processor, Services } from "./runtime.js";
import type { Settings } from "./settings.js";

/**
 * `worker-media`: the process that turns an upload into something the editor can
 * open (A07).
 *
 * ```
 * media.acquire  an authorised external source, downloaded into raw storage
 * media.probe    duration, dimensions, codec, rotation, HDR, loudness, silence
 * media.proxy    audio16k.wav · audio48k.wav · waveform.json · proxy540.mp4 · thumb-{n}.jpg
 * ```
 *
 * Boot order is deliberate: **FFmpeg is checked before Redis**. A worker without
 * a usable ffmpeg would connect, claim jobs and fail every one of them — three
 * times each, with backoff — which looks like a media outage rather than a missing
 * package. Refusing to start is loud, immediate and unambiguous.
 *
 * Shutdown is a two-part promise. `worker.close()` waits for jobs already in
 * flight so a rolling deploy never orphans one, and the shared `AbortController`
 * kills their ffmpeg children so "in flight" cannot mean "for another forty
 * minutes". A killed encode is a retryable failure and the next pod picks it up.
 */

const PROCESSORS: Readonly<Record<MediaQueue, Processor>> = {
  [MEDIA_ACQUIRE_QUEUE]: processAcquire,
  [MEDIA_PROBE_QUEUE]: processProbe,
  [MEDIA_PROXY_QUEUE]: processProxy,
};

function startWorkers(
  settings: Settings,
  services: Services,
  connection: IORedis,
  shutdown: AbortSignal,
): Worker[] {
  return settings.queues.map((queue) => {
    // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
    const worker = new Worker(queue, makeHandler(queue, PROCESSORS[queue], services, shutdown), {
      connection,
      ...workerOptions(queue, {
        concurrency: settings.concurrency,
        prefix: settings.queuePrefix,
      }),
    });

    worker.on("ready", () => {
      logger.info(`worker-media ready — waiting for jobs on ${queue}`, {
        queue,
        concurrency: settings.concurrency,
        prefix: settings.queuePrefix,
      });
    });
    worker.on("failed", (job, error) => {
      logger.error("job failed", { queue, bullJobId: job?.id, error: error.message });
    });
    worker.on("error", (error) => {
      logger.error("worker error", { queue, error: error.message });
    });
    return worker;
  });
}

async function main(): Promise<void> {
  loadRepoDotenv();
  const settings = resolveSettings();

  const tools = await assertMediaToolsAvailable({
    ffmpeg: settings.ffmpegPath,
    ffprobe: settings.ffprobePath,
  });
  for (const { tool, version } of tools) logger.info("media tool available", { tool, version });

  // The downloader is checked ONLY when this pod actually consumes the queue that
  // uses it, for the same reason ffmpeg is checked at all: a pod that will never
  // acquire anything should not be refused for a binary it does not need. When it
  // IS consumed, the version and digest are verified before a single job is taken
  // — an unpinned downloader running a user's URL is exactly what ADR 0002 §7
  // forbids, and finding out mid-job is finding out too late.
  if (settings.queues.includes(MEDIA_ACQUIRE_QUEUE)) {
    const downloader = await assertYtDlpUsable({
      binary: settings.ytDlpPath,
      verifyDigest: settings.ytDlpVerifyDigest,
    });
    logger.info("media tool available", {
      tool: "yt-dlp",
      version: downloader.version,
      digestVerified: downloader.sha256 !== null,
    });
  }

  // BullMQ uses blocking commands, so retries-per-request must be disabled.
  const connection = new IORedis(settings.env.REDIS_URL, { maxRetriesPerRequest: null });
  const services = buildServices(settings);
  const stopping = new AbortController();
  const workers = startWorkers(settings, services, connection, stopping.signal);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal });
    // Kill the ffmpeg children first: `close()` waits for in-flight jobs, and a
    // forty-minute encode would hold the deployment open until the orchestrator
    // lost patience and SIGKILLed the pod mid-upload.
    stopping.abort();
    void Promise.all(workers.map(async (worker) => worker.close()))
      .then(async () => connection.quit())
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
