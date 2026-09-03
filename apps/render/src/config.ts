/**
 * Deployment configuration for the render node.
 *
 * `@montaj/config`'s `loadEnv` owns the frozen list of *product* variables
 * (CONTRACTS §1). Everything read here on top of that is **infrastructure
 * naming and sizing** — how many renders this pod runs at once, which encoder
 * the hardware has, where the font pack is mounted — which is the same
 * distinction `jobs.config.ts` draws for `MONTAJ_QUEUE_PREFIX` and the OTel
 * variables: a cap the pricing model depends on moves through a code review, a
 * pod's concurrency moves through a deployment.
 *
 * None of them is a secret and every one has a working default.
 */

import { isVideoEncoder, type VideoEncoder } from "./ffmpeg/graph.js";
import { heartbeatIntervalMs } from "./policies.js";
import { RENDER_VIDEO_QUEUE } from "./queues.js";
import { defaultPoolSize, MAX_RASTER_WORKERS } from "./render/pool.js";

export interface RenderSettings {
  /** Parallel renders per pod. Renders are CPU-bound; one per pod is the floor. */
  readonly concurrency: number;
  /** `libx264` unless the node has an NVENC card (`05 §5.2`). */
  readonly encoder: VideoEncoder;
  /** Directory holding the font pack; unset falls back to the bundled subsets. */
  readonly fontDir: string | undefined;
  /** Scratch space for downloads and the encoder's output. */
  readonly workDir: string | undefined;
  /**
   * How often to post progress.
   *
   * Capped at the queue's heartbeat interval, because the progress callback *is*
   * the heartbeat: a render that reported less often than that could be declared
   * stalled while it was working perfectly (A08b).
   */
  readonly progressIntervalMs: number;
  /**
   * Rasteriser threads per render.
   *
   * `min(cores − 1, 4)` by default: one core is left for the thread feeding
   * ffmpeg, and past four the encoder is the bottleneck rather than Skia, so a
   * fifth worker only takes a core x264 wanted. `0` turns the pool off and
   * rasterises inline, which is the fallback a machine without worker threads
   * lands on anyway.
   */
  readonly rasterWorkers: number;
  /** Redis key prefix; matches the API's `queuePrefix()`. */
  readonly queuePrefix: string;
  readonly logLevel: string;
}

function intFrom(
  source: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  // eslint-disable-next-line security/detect-object-injection -- bracket/dynamic-key access on an internal, enum-bounded or already-validated key (schema/manifest/type-narrowed), not attacker-controlled -- reviewed for M06's eslint-plugin-security promotion
  const raw = source[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

/** Redis key prefix for every BullMQ structure; mirrors the API's `queuePrefix`. */
export function queuePrefix(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source["MONTAJ_QUEUE_PREFIX"]?.trim();
  return raw === undefined || raw === "" ? "bull" : raw;
}

export function loadRenderSettings(source: NodeJS.ProcessEnv = process.env): RenderSettings {
  const encoderName = source["RENDER_VIDEO_ENCODER"]?.trim();
  const heartbeat = heartbeatIntervalMs(RENDER_VIDEO_QUEUE);
  const fontDir = source["RENDER_FONT_DIR"]?.trim();
  const workDir = source["RENDER_WORK_DIR"]?.trim();

  const workersRaw = source["RENDER_RASTER_WORKERS"]?.trim();
  const rasterWorkers =
    workersRaw === undefined || workersRaw === ""
      ? defaultPoolSize()
      : intFrom(source, "RENDER_RASTER_WORKERS", defaultPoolSize(), 0, MAX_RASTER_WORKERS);

  return {
    concurrency: intFrom(source, "RENDER_CONCURRENCY", 1, 1, 32),
    rasterWorkers,
    encoder: isVideoEncoder(encoderName) ? encoderName : "libx264",
    fontDir: fontDir === undefined || fontDir === "" ? undefined : fontDir,
    workDir: workDir === undefined || workDir === "" ? undefined : workDir,
    progressIntervalMs: Math.min(
      heartbeat,
      intFrom(source, "RENDER_PROGRESS_INTERVAL_MS", 5_000, 250, heartbeat),
    ),
    queuePrefix: queuePrefix(source),
    logLevel: source["FFMPEG_LOG_LEVEL"]?.trim() ?? "error",
  };
}
