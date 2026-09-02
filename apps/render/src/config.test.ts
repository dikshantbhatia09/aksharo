import { describe, expect, it } from "vitest";

import { loadRenderSettings, queuePrefix } from "./config.js";
import { heartbeatIntervalMs } from "./policies.js";
import { RENDER_VIDEO_QUEUE } from "./queues.js";
import { defaultPoolSize, MAX_RASTER_WORKERS } from "./render/pool.js";

describe("the render settings", () => {
  it("has a working default for every knob", () => {
    const settings = loadRenderSettings({});
    expect(settings).toEqual({
      concurrency: 1,
      rasterWorkers: defaultPoolSize(),
      encoder: "libx264",
      fontDir: undefined,
      workDir: undefined,
      progressIntervalMs: 5_000,
      queuePrefix: "bull",
      logLevel: "error",
    });
  });

  it("reads the concurrency, and refuses a silly one", () => {
    expect(loadRenderSettings({ RENDER_CONCURRENCY: "4" }).concurrency).toBe(4);
    expect(loadRenderSettings({ RENDER_CONCURRENCY: "0" }).concurrency).toBe(1);
    expect(loadRenderSettings({ RENDER_CONCURRENCY: "9999" }).concurrency).toBe(32);
    expect(loadRenderSettings({ RENDER_CONCURRENCY: "abc" }).concurrency).toBe(1);
    expect(loadRenderSettings({ RENDER_CONCURRENCY: "  " }).concurrency).toBe(1);
  });

  it("switches to NVENC only for a name it knows", () => {
    expect(loadRenderSettings({ RENDER_VIDEO_ENCODER: "h264_nvenc" }).encoder).toBe("h264_nvenc");
    expect(loadRenderSettings({ RENDER_VIDEO_ENCODER: "hevc_qsv" }).encoder).toBe("libx264");
  });

  it("never lets the progress interval outrun the heartbeat", () => {
    // The progress callback *is* the heartbeat: a render reporting less often
    // than the queue's interval could be declared stalled while it was working.
    const heartbeat = heartbeatIntervalMs(RENDER_VIDEO_QUEUE);
    expect(
      loadRenderSettings({ RENDER_PROGRESS_INTERVAL_MS: String(heartbeat * 10) })
        .progressIntervalMs,
    ).toBe(heartbeat);
    expect(loadRenderSettings({ RENDER_PROGRESS_INTERVAL_MS: "1" }).progressIntervalMs).toBe(250);
    expect(loadRenderSettings({ RENDER_PROGRESS_INTERVAL_MS: "1000" }).progressIntervalMs).toBe(
      1_000,
    );
  });

  it("sizes the rasteriser pool at min(cores − 1, 4) unless told otherwise", () => {
    expect(loadRenderSettings({}).rasterWorkers).toBe(defaultPoolSize());
    expect(loadRenderSettings({ RENDER_RASTER_WORKERS: "2" }).rasterWorkers).toBe(2);
    // Zero is the documented way to rasterise inline, so it must survive.
    expect(loadRenderSettings({ RENDER_RASTER_WORKERS: "0" }).rasterWorkers).toBe(0);
    expect(loadRenderSettings({ RENDER_RASTER_WORKERS: "99" }).rasterWorkers).toBe(
      MAX_RASTER_WORKERS,
    );
    expect(loadRenderSettings({ RENDER_RASTER_WORKERS: "  " }).rasterWorkers).toBe(
      defaultPoolSize(),
    );
  });

  it("treats an empty directory variable as unset", () => {
    expect(loadRenderSettings({ RENDER_FONT_DIR: "", RENDER_WORK_DIR: "  " })).toMatchObject({
      fontDir: undefined,
      workDir: undefined,
    });
    expect(loadRenderSettings({ RENDER_FONT_DIR: "/fonts" }).fontDir).toBe("/fonts");
    expect(loadRenderSettings({ RENDER_WORK_DIR: "/scratch" }).workDir).toBe("/scratch");
  });
});

describe("the queue prefix", () => {
  it("defaults to BullMQ's own, so producers and consumers cannot talk past each other", () => {
    expect(queuePrefix({})).toBe("bull");
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "  " })).toBe("bull");
  });

  it("can isolate a shared Redis", () => {
    expect(queuePrefix({ MONTAJ_QUEUE_PREFIX: "a20" })).toBe("a20");
    expect(loadRenderSettings({ MONTAJ_QUEUE_PREFIX: "a20" }).queuePrefix).toBe("a20");
  });
});
