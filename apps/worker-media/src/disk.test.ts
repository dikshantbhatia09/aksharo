import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIP_BYTES_PER_SECOND,
  DOWNLOAD_HEADROOM,
  DiskGuard,
  PROXY_BYTES_PER_SECOND,
  RESERVE_BYTES,
  SCRATCH_HEADROOM,
  expectedScratchBytes,
  logDiskAtBoot,
  requiredFreeBytes,
} from "./disk.js";
import { logger } from "./logger.js";

import type { StatFs } from "./disk.js";

/**
 * Disk admission, decided without a disk: `statfs` is injected, so "the volume
 * has 1.6 GB left" is a number here rather than a full drive.
 */

const GIB = 1024 ** 3;
const FLOOR = 5 * GIB;

/** A volume with `free` bytes available, counted the way statfs counts them. */
function volume(free: number | bigint): StatFs & ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    typeof free === "bigint"
      ? { bavail: free / 4096n, bsize: 4096n }
      : { bavail: Math.floor(free / 4096), bsize: 4096 },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("expectedScratchBytes", () => {
  it("sizes a proxy by the source's running time", () => {
    expect(expectedScratchBytes("media.proxy", { durationMs: 3 * 60 * 60 * 1000 })).toBe(
      3 * 60 * 60 * PROXY_BYTES_PER_SECOND,
    );
  });

  it("sizes a clip by its cut, handles included", () => {
    expect(
      expectedScratchBytes("media.clip", { startMs: 10_000, endMs: 70_000, handleMs: 1_000 }),
    ).toBe(62 * CLIP_BYTES_PER_SECOND);
  });

  it("does not guess an acquisition, or a payload that does not say", () => {
    // How big the video is, nobody knows until its metadata has been read.
    expect(expectedScratchBytes("media.acquire", { limits: { maxBytes: 50 * GIB } })).toBeNull();
    expect(expectedScratchBytes("media.proxy", {})).toBeNull();
    expect(expectedScratchBytes("media.proxy", { durationMs: -5 })).toBeNull();
    expect(expectedScratchBytes("media.clip", { startMs: 70_000, endMs: 10_000 })).toBeNull();
    expect(expectedScratchBytes("media.proxy", null)).toBeNull();
  });
});

describe("requiredFreeBytes", () => {
  it("is the floor, or three times the job's own bytes when that is more", () => {
    expect(requiredFreeBytes(FLOOR, null)).toBe(FLOOR);
    expect(requiredFreeBytes(FLOOR, GIB)).toBe(FLOOR);
    expect(requiredFreeBytes(GIB, 0.4 * GIB)).toBe(SCRATCH_HEADROOM * 0.4 * GIB);
    expect(requiredFreeBytes(0, null)).toBe(0);
  });

  it("never asks for more than the job's own bytes with the floor left after them", () => {
    // A 12-hour proxy writes about 12 GB: three times that is 36 GB, which
    // this machine may never have free, though 13 GB is all it needs.
    const twelveHours = 12 * 60 * 60 * PROXY_BYTES_PER_SECOND;
    expect(requiredFreeBytes(GIB, twelveHours)).toBe(twelveHours + GIB);
  });
});

describe("DiskGuard", () => {
  it("admits a job when the volume has room", async () => {
    const guard = new DiskGuard({
      path: "D:/scratch",
      minFreeBytes: FLOOR,
      statfs: volume(20 * GIB),
    });
    await expect(guard.check("media.acquire", {})).resolves.toMatchObject({
      admit: true,
      freeBytes: 20 * GIB,
      requiredBytes: FLOOR,
      path: "D:/scratch",
    });
  });

  it("holds an acquisition below the floor — the production volume's 1.6 GB on 2026-09-27", async () => {
    const statfs = volume(1.64e9);
    const guard = new DiskGuard({ path: "D:/scratch", minFreeBytes: FLOOR, statfs });
    await expect(guard.check("media.acquire", {})).resolves.toMatchObject({ admit: false });
    // The scratch volume is the one measured.
    expect(statfs).toHaveBeenCalledWith("D:/scratch");
  });

  it("starts a proxy or a clip against the reserve, not the acquisition's floor", async () => {
    // On 4.1 GB free, a 5 GiB floor for every job held every upload's proxy.
    const guard = new DiskGuard({ path: "D:/scratch", minFreeBytes: FLOOR, statfs: volume(4.1e9) });
    expect(guard.reserveBytes).toBe(RESERVE_BYTES);
    await expect(guard.check("media.proxy", { durationMs: 60_000 })).resolves.toMatchObject({
      admit: true,
      requiredBytes: RESERVE_BYTES,
    });
    await expect(
      guard.check("media.clip", { startMs: 0, endMs: 60_000 }),
    ).resolves.toMatchObject({ admit: true });
    await expect(guard.check("media.acquire", {})).resolves.toMatchObject({ admit: false });
  });

  it("holds a proxy whose own scratch and the reserve would not fit", async () => {
    // Three hours of proxy: about 3 GB, and the 1 GiB reserve after it.
    const low = new DiskGuard({ path: "D:/scratch", minFreeBytes: FLOOR, statfs: volume(3.5e9) });
    await expect(
      low.check("media.proxy", { durationMs: 3 * 60 * 60 * 1000 }),
    ).resolves.toMatchObject({ admit: false });
    const enough = new DiskGuard({ path: "D:/scratch", minFreeBytes: FLOOR, statfs: volume(6e9) });
    await expect(
      enough.check("media.proxy", { durationMs: 3 * 60 * 60 * 1000 }),
    ).resolves.toMatchObject({ admit: true });
  });

  it("reads statfs's bigint form too", async () => {
    const guard = new DiskGuard({
      path: "D:/scratch",
      minFreeBytes: FLOOR,
      statfs: volume(1n * 1024n ** 3n),
    });
    await expect(guard.check("media.acquire", {})).resolves.toMatchObject({
      admit: false,
      freeBytes: GIB,
    });
  });

  it("never measures, or holds, a queue that writes nothing large", async () => {
    const statfs = volume(0);
    const guard = new DiskGuard({ path: "D:/scratch", minFreeBytes: FLOOR, statfs });
    await expect(guard.check("media.probe", {})).resolves.toMatchObject({ admit: true });
    expect(statfs).not.toHaveBeenCalled();
  });

  it("starts the job, and says so, when the volume cannot be measured", async () => {
    // A guard that could not look is no reason to stop work.
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const guard = new DiskGuard({
      path: "D:/missing",
      minFreeBytes: FLOOR,
      statfs: vi.fn(async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
      }),
    });
    await expect(guard.check("media.acquire", {})).resolves.toMatchObject({
      admit: true,
      freeBytes: null,
    });
    await expect(guard.belowReserve()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("is off with a zero floor, for a job that brings no size of its own", async () => {
    const statfs = volume(0);
    const guard = new DiskGuard({ path: "D:/scratch", minFreeBytes: 0, statfs });
    await expect(guard.check("media.acquire", {})).resolves.toMatchObject({ admit: true });
    await expect(guard.belowReserve()).resolves.toBe(false);
    expect(statfs).not.toHaveBeenCalled();
  });

  it("measures the OS temp directory when no scratch directory is configured", async () => {
    const statfs = volume(20 * GIB);
    await new DiskGuard({ path: undefined, minFreeBytes: FLOOR, statfs }).check(
      "media.acquire",
      {},
    );
    expect(statfs).toHaveBeenCalledWith(tmpdir());
  });
});

describe("DiskGuard, once a download's size is known", () => {
  it("wants the floor plus twice the download free", async () => {
    // 2 GB of video: its parts and the merged file, and 5 GiB left after.
    const needed = FLOOR + DOWNLOAD_HEADROOM * 2e9;
    const short = new DiskGuard({ path: "D:/s", minFreeBytes: FLOOR, statfs: volume(needed - 4096) });
    await expect(short.roomToDownload(2e9)).resolves.toMatchObject({
      admit: false,
      requiredBytes: needed,
    });
    const room = new DiskGuard({ path: "D:/s", minFreeBytes: FLOOR, statfs: volume(needed + 4096) });
    await expect(room.roomToDownload(2e9)).resolves.toMatchObject({ admit: true });
    // Of unknown size: the floor alone, and the reserve while it runs.
    await expect(short.roomToDownload(null)).resolves.toMatchObject({ requiredBytes: FLOOR });
  });

  it("stops a running download below the reserve, whatever its own size", async () => {
    const low = new DiskGuard({ path: "D:/s", minFreeBytes: FLOOR, statfs: volume(0.9 * GIB) });
    await expect(low.belowReserve()).resolves.toBe(true);
    // Below the floor is no reason to stop one already running.
    const floorish = new DiskGuard({ path: "D:/s", minFreeBytes: FLOOR, statfs: volume(3 * GIB) });
    await expect(floorish.belowReserve()).resolves.toBe(false);
  });
});

describe("logDiskAtBoot", () => {
  it("says at error level, and returns, which queues would wait from the first job", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const guard = new DiskGuard({ path: "C:/scratch", minFreeBytes: FLOOR, statfs: volume(4.1e9) });
    await expect(
      logDiskAtBoot(guard, ["media.probe", "media.proxy", "media.clip", "media.acquire"]),
    ).resolves.toEqual(["media.acquire"]);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      freeBytes: expect.any(Number),
      minFreeBytes: FLOOR,
      waiting: ["media.acquire"],
    });
  });

  it("says it at info when there is room", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const guard = new DiskGuard({ path: "C:/scratch", minFreeBytes: FLOOR, statfs: volume(4.1e9) });
    // The plain worker takes no acquisitions, and 4.1 GB is room for the rest.
    await expect(logDiskAtBoot(guard, ["media.probe", "media.proxy", "media.clip"])).resolves.toEqual(
      [],
    );
    expect(error).not.toHaveBeenCalled();
    expect(info.mock.calls[0]?.[1]).toMatchObject({ reserveBytes: RESERVE_BYTES });
  });
});
