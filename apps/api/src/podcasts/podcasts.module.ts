import { Module } from "@nestjs/common";

import { ItunesSearchService } from "./itunes-search.service.js";
import { PodcastWatcherTask } from "./podcast-watcher.task.js";
import { PodcastsController } from "./podcasts.controller.js";
import { PodcastsService } from "./podcasts.service.js";
import { RssParserService } from "./rss-parser.service.js";

@Module({
  controllers: [PodcastsController],
  providers: [
    RssParserService,
    ItunesSearchService,
    PodcastsService,
    PodcastWatcherTask,
  ],
  exports: [
    PodcastsService,
    RssParserService,
    ItunesSearchService,
  ],
})
export class PodcastsModule {}

