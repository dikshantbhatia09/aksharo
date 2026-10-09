import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { PodcastsService } from "./podcasts.service.js";
import { ScheduledTasksService } from "../common/scheduler/scheduled-tasks.service.js";

export const PODCAST_WATCHER_TASK = "podcasts.episode-watcher";
export const PODCAST_WATCHER_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes (meets SLA: <= 15 minutes)

/**
 * Autonomous Episode Watcher (Pillar 1 §06).
 * Periodically polls connected active RSS feeds for newly published episodes
 * using HTTP conditional headers (ETag, If-Modified-Since).
 */
@Injectable()
export class PodcastWatcherTask implements OnModuleInit {
  private readonly logger = new Logger(PodcastWatcherTask.name);
  private running = false;

  constructor(
    private readonly scheduler: ScheduledTasksService,
    private readonly podcasts: PodcastsService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register({
      name: PODCAST_WATCHER_TASK,
      everyMs: PODCAST_WATCHER_INTERVAL_MS,
      run: () => this.run(),
    });
    this.logger.log(`Registered scheduled task "${PODCAST_WATCHER_TASK}" (every 15m)`);
  }

  /**
   * Execute one watcher tick across all active podcast shows.
   */
  async run(): Promise<void> {
    if (this.running) {
      this.logger.debug("Previous podcast watcher tick still running; skipping tick.");
      return;
    }

    this.running = true;
    const start = performance.now();

    try {
      this.logger.debug("Starting podcast episode watcher sweep...");
      const result = await this.podcasts.pollActiveShows();
      const elapsed = (performance.now() - start).toFixed(1);
      this.logger.log(
        `Podcast episode watcher finished in ${elapsed}ms: checked ${result.checked} shows, detected ${result.newEpisodes} new episodes.`,
      );
    } catch (err: any) {
      this.logger.error(`Podcast episode watcher sweep encountered an error: ${err?.message}`);
    } finally {
      this.running = false;
    }
  }
}

