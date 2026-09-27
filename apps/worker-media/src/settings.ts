import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, extname, join, parse, posix, win32 } from "node:path";

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
  /**
   * `ffmpegPath` as the file this worker actually runs, found the way `spawn`
   * finds it; `undefined` when it is on no PATH directory.
   *
   * For yt-dlp's `--ffmpeg-location`, so the merge uses the ffmpeg the boot
   * check verified. The default `FFMPEG_PATH` is the bare name `ffmpeg`, which
   * yt-dlp reads as a path that does not exist (and then merges with nothing),
   * so without this the flag was never passed on the host that runs production.
   */
  readonly ffmpegLocation: string | undefined;
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
  /**
   * Run a package-manager downloader that is not the pinned release, with a
   * warning, rather than refusing to boot (`WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED=1`).
   * Off unless asked for by name, and ignored while the digest is verified; see
   * `assertYtDlpUsable` for the trade-off it makes.
   */
  readonly ytDlpAllowUnpinned: boolean;
  /**
   * The JavaScript runtime the downloader may run YouTube's challenge scripts
   * in (`YT_DLP_JS_RUNTIME`): an absolute path to `node`, or `undefined` for
   * none.
   *
   * Without one, yt-dlp 2026.08.19 enables only deno (not installed here) and
   * falls back to a single YouTube client, which is the first thing a YouTube
   * change breaks. It is named by absolute path, never found on PATH, because
   * this is an executable that runs code a website sent: the one that runs has
   * to be the one a deployment chose. yt-dlp starts it with Node's permission
   * model, which denies file-system and child-process access to the script.
   */
  readonly ytDlpJsRuntime: string | undefined;
  /** Where scratch files go; `undefined` means the OS temp directory. */
  readonly tempDir: string | undefined;
  /**
   * The free space an acquisition needs on the scratch volume before it may
   * start (`WORKER_MEDIA_MIN_FREE_BYTES`); a proxy or a clip needs the smaller
   * reserve (1 GiB, or this when it is lower), or three times its own
   * expected scratch bytes when that is more. See `disk.ts`. `0` turns every
   * check off.
   */
  readonly minFreeBytes: number;
  /**
   * `ALERT_WEBHOOK_URL`, as given: the ntfy topic this process alerts when it
   * cannot start, or when jobs wait for disk (`alert.ts`). Never logged.
   */
  readonly alertWebhookUrl: string | undefined;
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

/**
 * The free space below which no acquisition starts: 5 GiB. (A proxy or a clip
 * brings its own size, and starts against the 1 GiB reserve; see `disk.ts`.)
 *
 * The scratch directory shares a volume with Postgres, Redis and MinIO on the
 * machine that runs production. A download that fills it does not fail on its
 * own: it takes the database down with it. Five gigabytes is a 1080p download
 * of about three hours with room left for the merge. On a host with less free
 * than this, set `WORKER_MEDIA_MIN_FREE_BYTES` deliberately — or every
 * acquisition waits, and says so at boot.
 */
export const DEFAULT_MIN_FREE_BYTES = 5 * 1024 ** 3;

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

  const ffmpegPath = source["FFMPEG_PATH"]?.trim() || "ffmpeg";
  return {
    // `loadServiceEnv` and not `loadEnv`: this worker needs Redis, the two
    // object stores, the callback secret and API_ORIGIN. It opens no database
    // connection and mints no token, so demanding DATABASE_URL and the JWT keys
    // only forced the chart to hand them to every worker pod (P0-09).
    env: loadServiceEnv("worker-media", { source }),
    queues: requested.length === 0 ? MEDIA_QUEUES : (requested as MediaQueue[]),
    concurrency: positiveInteger(source["WORKER_MEDIA_CONCURRENCY"], DEFAULT_CONCURRENCY),
    queuePrefix: queuePrefix(source),
    ffmpegPath,
    ffmpegLocation: findExecutable(ffmpegPath, { env: source }),
    ffprobePath: source["FFPROBE_PATH"]?.trim() || "ffprobe",
    ytDlpPath: source["YT_DLP_PATH"]?.trim() || "yt-dlp",
    // Explicit opt-out, not opt-in: a deployment that forgets to set this gets
    // the safe behaviour, and the unsafe one has to be asked for by name.
    ytDlpVerifyDigest: source["WORKER_MEDIA_YT_DLP_VERIFY"] !== "0",
    // The same rule, for the same reason.
    ytDlpAllowUnpinned: source["WORKER_MEDIA_YT_DLP_ALLOW_UNPINNED"] === "1",
    ytDlpJsRuntime: jsRuntime(source["YT_DLP_JS_RUNTIME"]),
    tempDir: source["WORKER_MEDIA_TEMP_DIR"]?.trim() || undefined,
    minFreeBytes: nonNegativeInteger(source["WORKER_MEDIA_MIN_FREE_BYTES"], DEFAULT_MIN_FREE_BYTES),
    alertWebhookUrl: source["ALERT_WEBHOOK_URL"]?.trim() || undefined,
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

/**
 * The file `spawn(name)` would run, or `undefined` when there is none.
 *
 * A name with a path in it is returned as it is. A bare name is looked up the
 * way libuv does it: on Windows the working directory first, then each PATH
 * directory, appending `.com` and then `.exe` (after the name as written, when
 * it already has an extension); elsewhere each PATH directory, for an
 * executable file. Exported for its tests, which pass the platform and PATH.
 */
export function findExecutable(
  name: string,
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    readonly cwd?: string;
  } = {},
): string | undefined {
  if (/[\\/]/.test(name)) return name;
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === "win32";
  // `process.env` ignores case on Windows; a plain object handed in does not.
  const searchPath = env["PATH"] ?? env["Path"] ?? "";
  const directories = searchPath
    .split(windows ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
  const candidates = windows
    ? [...(extname(name) === "" ? [] : [name]), `${name}.com`, `${name}.exe`]
    : [name];

  for (const directory of windows ? [options.cwd ?? process.cwd(), ...directories] : directories) {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      if (isRunnableFile(path, windows)) return path;
    }
  }
  return undefined;
}

function isRunnableFile(path: string, windows: boolean): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- a PATH directory joined with a configured tool name, not user input
    if (!statSync(path).isFile()) return false;
    if (!windows) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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

/** As {@link positiveInteger}, except that an explicit `0` means zero (off). */
function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value?.trim() === "0") return 0;
  return positiveInteger(value, fallback);
}

/**
 * `YT_DLP_JS_RUNTIME`: empty is "no runtime", anything else must be an absolute
 * path. A relative one is refused rather than resolved, for the reason
 * `WORKER_MEDIA_QUEUES` is: a runtime quietly found somewhere else is a
 * different executable running YouTube's scripts than the one configured.
 */
function jsRuntime(value: string | undefined): string | undefined {
  const path = value?.trim() ?? "";
  if (path === "") return undefined;
  if (!(win32.isAbsolute(path) || posix.isAbsolute(path)) || path.includes("\0")) {
    throw new Error(
      `YT_DLP_JS_RUNTIME must be an absolute path to node, not ${JSON.stringify(path)}`,
    );
  }
  return path;
}
