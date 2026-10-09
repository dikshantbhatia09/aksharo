import { describe, expect, it, vi } from "vitest";
import {
  PodcastWatcherTask,
  PODCAST_WATCHER_TASK,
  PODCAST_WATCHER_INTERVAL_MS,
} from "./podcast-watcher.task.js";

describe("PodcastWatcherTask", () => {
  it("registers itself with ScheduledTasksService on module init", () => {
    const mockScheduler = { register: vi.fn() };
    const mockPodcasts = { pollActiveShows: vi.fn() };

    const task = new PodcastWatcherTask(mockScheduler as any, mockPodcasts as any);
    task.onModuleInit();

    expect(mockScheduler.register).toHaveBeenCalledWith(
      expect.objectContaining({
        name: PODCAST_WATCHER_TASK,
        everyMs: PODCAST_WATCHER_INTERVAL_MS,
      }),
    );
  });

  it("executes sweep and calls pollActiveShows", async () => {
    const mockScheduler = { register: vi.fn() };
    const mockPodcasts = {
      pollActiveShows: vi.fn().mockResolvedValue({ checked: 3, newEpisodes: 2 }),
    };

    const task = new PodcastWatcherTask(mockScheduler as any, mockPodcasts as any);
    await task.run();

    expect(mockPodcasts.pollActiveShows).toHaveBeenCalledTimes(1);
  });

  it("prevents overlapping concurrent ticks", async () => {
    const mockScheduler = { register: vi.fn() };
    let finishFirst: () => void = () => {};
    const hangingPromise = new Promise<{ checked: number; newEpisodes: number }>((resolve) => {
      finishFirst = () => resolve({ checked: 1, newEpisodes: 0 });
    });

    const mockPodcasts = {
      pollActiveShows: vi.fn().mockReturnValue(hangingPromise),
    };

    const task = new PodcastWatcherTask(mockScheduler as any, mockPodcasts as any);

    // Start first tick (hanging)
    const tick1 = task.run();

    // Start second tick while first is still running
    await task.run();

    // pollActiveShows should only be called once because tick 2 skipped
    expect(mockPodcasts.pollActiveShows).toHaveBeenCalledTimes(1);

    finishFirst();
    await tick1;
  });
});

