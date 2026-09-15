import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

import { config as loadDotenvFile } from "dotenv";

import { loadServiceEnv } from "@montaj/config";
import type { ServiceEnv } from "@montaj/config";

import { MEDIA_QUEUES } from "./queues.js";

import type { MediaQueue } from "./queues.js";

/**
 * Everything this process needs, resolved once at boot.
 *
 * Two sources, kept apart on purpose:
 *
 * - **`ServiceEnv<"worker-media">`** is the slice of the CONTRACTS §1 product
 *   configuration THIS worker needs, validated fail-fast by `loadServiceEnv()`.
 *   Buckets, endpoints, the callback secret — deliberately not the database URL
 *   or the JWT keys, which it never reads and must therefore never be given.
 * - **`WORKER_MEDIA_*` and `MONTAJ_QUEUE_PREFIX`** are deployment tuning — how
 *   many jobs at once, which queues this pod takes, where ffmpeg lives. They are
 *   read straight from `process.env` for the same reason `queuePrefix()` in the
 *   API is: CONTRACTS §1 is the list of *product* configuration, and a
 *   concurrency number is not on it.
 *
 * No value from either is ever logged (THREAT-MODEL T21).
 */
export interface Settings {
  readonly env: ServiceEnv<"worker-media">;
  /** Queues this process consumes; `WORKER_MEDIA_QUEUES` narrows it. */
  readonly queues: readonly MediaQueue[];
  readonly concurrency: number;
  /** BullMQ key prefix, shared with the API's producer side. */
  readonly queuePrefix: string;
  readonly ffmpegPath: string;
  readonly ffprobePath: string;
  /** The pinned downloader (REP-010). Its version is checked before first use. */
  readonly ytDlpPath: string;
  /**
   * Verify the downloader's SHA-256 at boot.
   *
   * On by default in production and off for a developer machine, where the binary
   * came from a package manager and hashing it proves nothing. It is a separate
   * switch from the path because "I have yt-dlp" and "I have THE yt-dlp" are
   * different claims, and only the second one may run a user's URL.
   */
  readonly ytDlpVerifyDigest: boolean;
  /** Where scratch files go; `undefined` means the OS temp directory. */
  readonly tempDir: string | undefined;
  /** How long a signed read URL for the source object stays valid. */
  readonly sourceUrlTtlSeconds: number;
  /** Ceiling on one ffmpeg run, so a wedged process cannot hold a lock forever. */
  readonly ffmpegTimeoutMs: number;
  /** Skip the EBU R128 pass; the probe still reports everything else. */
  readonly loudnessEnabled: boolean;
}

/** Default parallel jobs per queue. Media work is CPU-bound; two is a safe floor. */
export const DEFAULT_CONCURRENCY = 2;

/**
 * A signed source URL has to outlive the longest job that reads through it.
 *
 * Six hours: comfortably past the ten-minute lock and its retries, and still far
 * short of anything worth stealing by the time it leaks. ffmpeg re-opens the URL
 * for every seek, so the whole job — not just its first byte — is inside this
 * window.
 */
export const SOURCE_URL_TTL_SECONDS = 6 * 60 * 60;

/** One ffmpeg run may take this long. Longer than the lock, because retries exist. */
export const FFMPEG_TIMEOUT_MS = 45 * 60_000;

/** Load the nearest `.env` walking up to the repo root; real env vars win. */
export function loadRepoDotenv(startDir: string = process.cwd()): void {
  let dir = startDir;
  const { root } = parse(dir);
  for (;;) {
    const candidate = join(dir, ".env");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built from internal, non-attacker-controlled segments (manifest/config/workspace/fixture/build-output paths), not user input -- reviewed for M06's eslint-plugin-security promotion
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

/**
 * Resolve {@link Settings} from an environment.
 *
 * @throws Error when `WORKER_MEDIA_QUEUES` names a queue this worker does not own
 *   — a configuration error is refused rather than silently ignored, because a pod
 *   pinned to a queue nothing consumes looks healthy and does nothing.
 */
export function resolveSettings(source: NodeJS.ProcessEnv = process.env): Settings {
  const requested = split(source["WORKER_MEDIA_QUEUES"]);
  const unknown = requested.filter((name) => !(MEDIA_QUEUES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `WORKER_MEDIA_QUEUES names queues this worker does not own: ${unknown.join(", ")}`,
    );
  }

  return {
    // `loadServiceEnv` and not `loadEnv`: this worker needs Redis, the two
    // object stores, the callback secret and API_ORIGIN. It opens no database
    // connection and mints no token, so demanding DATABASE_URL and the JWT keys
    // only forced the chart to hand them to every worker pod (P0-09).
    env: loadServiceEnv("worker-media", { source }),
    queues: requested.length === 0 ? MEDIA_QUEUES : (requested as MediaQueue[]),
    concurrency: positiveInteger(source["WORKER_MEDIA_CONCURRENCY"], DEFAULT_CONCURRENCY),
    queuePrefix: queuePrefix(source),
    ffmpegPath: source["FFMPEG_PATH"]?.trim() || "ffmpeg",
    ffprobePath: source["FFPROBE_PATH"]?.trim() || "ffprobe",
    ytDlpPath: source["YT_DLP_PATH"]?.trim() || "yt-dlp",
    // Explicit opt-out, not opt-in: a deployment that forgets to set this gets
    // the safe behaviour, and the unsafe one has to be asked for by name.
    ytDlpVerifyDigest: source["WORKER_MEDIA_YT_DLP_VERIFY"] !== "0",
    tempDir: source["WORKER_MEDIA_TEMP_DIR"]?.trim() || undefined,
    sourceUrlTtlSeconds: positiveInteger(
      source["WORKER_MEDIA_SOURCE_URL_TTL"],
      SOURCE_URL_TTL_SECONDS,
    ),
    ffmpegTimeoutMs: positiveInteger(source["WORKER_MEDIA_FFMPEG_TIMEOUT_MS"], FFMPEG_TIMEOUT_MS),
    loudnessEnabled: source["WORKER_MEDIA_LOUDNESS"] !== "0",
  };
}

/**
 * BullMQ key prefix. Must match `queuePrefix()` in `apps/api/src/jobs/jobs.config.ts`
 * exactly, or producer and consumer talk past each other in silence.
 */
export function queuePrefix(source: NodeJS.ProcessEnv = process.env): string {
  const raw = source["MONTAJ_QUEUE_PREFIX"]?.trim();
  return raw === undefined || raw === "" ? "bull" : raw;
}

function split(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
