import { statfs as fsStatfs } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describeError } from "./errors.js";
import { logger } from "./logger.js";
import {
  MEDIA_ACQUIRE_QUEUE,
  MEDIA_CLIP_QUEUE,
  MEDIA_PROXY_QUEUE,
  MEDIA_STILLS_QUEUE,
} from "./queues.js";

/**
 * Disk admission: a download, an encode or a cut does not START without room
 * to finish, and a download does not go on writing once the volume is nearly
 * full.
 *
 * On the machine that runs production the scratch directory shares a volume
 * with Postgres, Redis and MinIO. A job that fills it does not merely fail: it
 * takes the database and the object store down with it, and every other job
 * with them. On 2026-09-27 that volume had between 1.6 and 5.8 GB free over the
 * day, while a three-hour source needs about 3.5 GB of scratch. So the three
 * disk-heavy queues check first, and a job that does not fit WAITS: it goes
 * back to BullMQ's delayed set for {@link DISK_RETRY_DELAY_MS} without spending
 * an attempt, and runs by itself once space is freed (the runtime ends one that
 * has waited {@link DISK_HOLD_MAX_MS}). It is never failed for disk on a first
 * look — a full disk is the machine's problem, not the user's video's.
 *
 * Two lines, not one:
 *
 * - **The floor** (`WORKER_MEDIA_MIN_FREE_BYTES`, 5 GiB): what an ACQUISITION
 *   needs free to start. It is large because nobody knows how big the video is
 *   until its metadata has been read; once it has been, the acquisition checks
 *   again for its real size ({@link DiskGuard.roomToDownload}).
 * - **The reserve** ({@link RESERVE_BYTES}, 1 GiB, or the floor when that is
 *   lower): what the volume keeps whatever runs. It is the floor for a proxy or
 *   a clip, whose own size is known from its payload — a one-minute proxy
 *   writes 17 MB, and holding it for 5 GiB stopped every upload on a volume
 *   with 4 GB free — and the line a running download is killed at.
 *
 * `media.probe` is left alone: it reads through a signed URL and writes
 * nothing.
 */

/** The queues whose jobs write large scratch files. */
export const DISK_GUARDED_QUEUES: ReadonlySet<string> = new Set([
  MEDIA_ACQUIRE_QUEUE,
  MEDIA_PROXY_QUEUE,
  MEDIA_CLIP_QUEUE,
  // A clip's images are small, but they come in bursts of many clips, and on
  // a nearly full volume they are the first thing worth holding back.
  MEDIA_STILLS_QUEUE,
]);

/** How long a job that did not fit waits before it asks again. */
export const DISK_RETRY_DELAY_MS = 60_000;

/**
 * How long a job may wait for disk before it is failed: six hours.
 *
 * Without a bound it never learns that its run is over — a stopped run's job,
 * or one the API has already failed for waiting, cycled through the delayed
 * set every minute until the disk was freed — and a job whose need is more
 * than the volume can ever free would wait forever. Six hours is long past
 * every plan's queue wait, and long enough for an operator to free space.
 */
export const DISK_HOLD_MAX_MS = 6 * 60 * 60_000;

/**
 * What the volume keeps free whatever runs: 1 GiB for Postgres, Redis and
 * MinIO to go on writing. Lowered to the floor when the floor is lower, so a
 * floor of `0` turns every check off.
 */
export const RESERVE_BYTES = 1024 ** 3;

/**
 * A job needs this many times its own expected scratch bytes free — the file
 * itself, a second copy while it is merged or cut, and room for everything
 * else on the volume to keep writing — but never more than its own bytes plus
 * its floor (see {@link requiredFreeBytes}).
 */
export const SCRATCH_HEADROOM = 3;

/**
 * Room a download needs on top of the floor, as a multiple of its size: its
 * parts, and the merged file next to them.
 */
export const DOWNLOAD_HEADROOM = 2;

/**
 * Scratch a proxy writes per second of source: mono 16 kHz PCM (32 kB/s),
 * mono 48 kHz PCM (96 kB/s) and a 540p proxy (about 150 kB/s), all held until
 * the job ends. A three-hour source: about 3 GB.
 */
export const PROXY_BYTES_PER_SECOND = 280_000;

/** Scratch a clip writes per second of cut: a 1080 x 1920 H.264 mezzanine, about 8 Mbit/s. */
export const CLIP_BYTES_PER_SECOND = 1_000_000;

export type StatFs = (path: string) => Promise<{
  readonly bavail: number | bigint;
  readonly bsize: number | bigint;
}>;

export interface DiskVerdict {
  readonly admit: boolean;
  /** `null` when the volume could not be measured (and the job was admitted). */
  readonly freeBytes: number | null;
  readonly requiredBytes: number;
  readonly path: string;
}

/**
 * What a job is expected to write to scratch, from its own payload; `null`
 * when the payload cannot say. An acquisition cannot: how big the video is,
 * nobody knows until its metadata has been read, so it is held to the floor.
 */
export function expectedScratchBytes(queueName: string, payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const fields = payload as Record<string, unknown>;
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  if (queueName === MEDIA_PROXY_QUEUE) {
    const durationMs = fields["durationMs"];
    return positive(durationMs) ? Math.round((durationMs / 1000) * PROXY_BYTES_PER_SECOND) : null;
  }
  if (queueName === MEDIA_CLIP_QUEUE) {
    const { startMs, endMs, handleMs } = fields;
    if (typeof startMs !== "number" || !positive(endMs) || endMs <= startMs) return null;
    const handles = positive(handleMs) ? 2 * handleMs : 0;
    return Math.round(((endMs - startMs + handles) / 1000) * CLIP_BYTES_PER_SECOND);
  }
  return null;
}

/**
 * The free space a job needs to start: its floor, or {@link SCRATCH_HEADROOM}
 * times its own bytes when that is more — capped at its own bytes plus the
 * floor. Past that cap the job fits with the floor still free after it, and
 * asking for more only holds a large job on a volume that can take it: a
 * 12-hour proxy writes about 12 GB, which at 3x is 36 GB, more than this
 * machine may ever have free.
 */
export function requiredFreeBytes(floorBytes: number, expectedBytes: number | null): number {
  if (expectedBytes === null) return floorBytes;
  return Math.max(
    floorBytes,
    Math.min(SCRATCH_HEADROOM * expectedBytes, expectedBytes + floorBytes),
  );
}

/**
 * Checks one volume. `statfs` is injectable, so the rule is tested without
 * filling a disk.
 */
export class DiskGuard {
  readonly path: string;
  /** What an acquisition needs free to start (`WORKER_MEDIA_MIN_FREE_BYTES`). */
  readonly minFreeBytes: number;
  /** What the volume keeps whatever runs; see the module comment. */
  readonly reserveBytes: number;
  private readonly statfs: StatFs;

  constructor(options: {
    /** The scratch directory (`WORKER_MEDIA_TEMP_DIR`); the OS temp directory when unset. */
    readonly path: string | undefined;
    readonly minFreeBytes: number;
    readonly statfs?: StatFs;
  }) {
    this.path = options.path ?? tmpdir();
    this.minFreeBytes = options.minFreeBytes;
    this.reserveBytes = Math.min(options.minFreeBytes, RESERVE_BYTES);
    this.statfs = options.statfs ?? fsStatfs;
  }

  /** The floor a queue's jobs start against: the acquisition's, or the reserve. */
  floorFor(queueName: string): number {
    return queueName === MEDIA_ACQUIRE_QUEUE ? this.minFreeBytes : this.reserveBytes;
  }

  /**
   * Free bytes on the volume, or `null` when it cannot be measured. A guard
   * that could not look is no reason to stop work, only to say so.
   */
  async freeBytes(context: Record<string, unknown> = {}): Promise<number | null> {
    try {
      const facts = await this.statfs(this.path);
      const free = Number(facts.bavail) * Number(facts.bsize);
      return Number.isFinite(free) ? free : null;
    } catch (error) {
      logger.warn("could not measure free disk space; going ahead", {
        path: this.path,
        ...context,
        error: describeError(error),
      });
      return null;
    }
  }

  /**
   * Whether a job on `queueName` with this payload may start now. Queues that
   * write nothing large are always admitted, and so is a job whose volume
   * cannot be measured.
   */
  async check(queueName: string, payload: unknown): Promise<DiskVerdict> {
    const requiredBytes = requiredFreeBytes(
      this.floorFor(queueName),
      expectedScratchBytes(queueName, payload),
    );
    if (!DISK_GUARDED_QUEUES.has(queueName) || requiredBytes <= 0) {
      return { admit: true, freeBytes: null, requiredBytes, path: this.path };
    }
    return this.verdict(requiredBytes, { queue: queueName });
  }

  /**
   * Whether a download of about `expectedBytes` may start: the floor, plus
   * {@link DOWNLOAD_HEADROOM} times its size. Asked by an acquisition once
   * its metadata has said how big the video is, and again before it falls
   * back to fetching a whole video — the one download here that can be ten
   * gigabytes. An unknown size is held to the floor alone; the size watch
   * ({@link DiskGuard.belowReserve}) is its limit while it runs.
   */
  async roomToDownload(expectedBytes: number | null): Promise<DiskVerdict> {
    const requiredBytes =
      this.minFreeBytes + (expectedBytes === null ? 0 : DOWNLOAD_HEADROOM * expectedBytes);
    if (requiredBytes <= 0) {
      return { admit: true, freeBytes: null, requiredBytes, path: this.path };
    }
    return this.verdict(requiredBytes, { queue: MEDIA_ACQUIRE_QUEUE });
  }

  /**
   * True when the volume is below the reserve: a running download stops here,
   * whatever its own size, because the database is next to fill.
   */
  async belowReserve(): Promise<boolean> {
    if (this.reserveBytes <= 0) return false;
    const free = await this.freeBytes({ check: "reserve" });
    return free !== null && free < this.reserveBytes;
  }

  private async verdict(
    requiredBytes: number,
    context: Record<string, unknown>,
  ): Promise<DiskVerdict> {
    const freeBytes = await this.freeBytes(context);
    return {
      admit: freeBytes === null || freeBytes >= requiredBytes,
      freeBytes,
      requiredBytes,
      path: this.path,
    };
  }
}

/**
 * Say at boot where the scratch volume stands against its lines — at `error`
 * when a job on one of this process's queues could not start now, because from
 * then on every one of them waits and the only other sign is a job that never
 * moves. Returns the queues that would wait, for the caller's alert.
 */
export async function logDiskAtBoot(
  guard: DiskGuard,
  queues: readonly string[],
): Promise<readonly string[]> {
  const freeBytes = await guard.freeBytes({ check: "boot" });
  const fields = {
    path: guard.path,
    freeBytes,
    minFreeBytes: guard.minFreeBytes,
    reserveBytes: guard.reserveBytes,
    queues,
  };
  const waiting =
    freeBytes === null
      ? []
      : queues.filter(
          (queue) => DISK_GUARDED_QUEUES.has(queue) && freeBytes < guard.floorFor(queue),
        );
  if (waiting.length > 0) {
    logger.error(
      "scratch volume is below its floor: jobs on these queues will wait until space is freed",
      { ...fields, waiting },
    );
  } else {
    logger.info("disk admission", fields);
  }
  return waiting;
}
