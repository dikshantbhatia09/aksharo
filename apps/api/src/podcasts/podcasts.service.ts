import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ulid } from "ulid";

import { ItunesSearchService } from "./itunes-search.service.js";
import {
  ConnectPodcastDto,
  PodcastEpisodeViewDto,
  PodcastShowViewDto,
  RepurposeEpisodeDto,
  UpdatePodcastShowDto,
} from "./podcasts.dto.js";
import { RssParserService } from "./rss-parser.service.js";
import { PrismaService } from "../common/prisma/prisma.service.js";

@Injectable()
export class PodcastsService {
  private readonly logger = new Logger(PodcastsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rssParser: RssParserService,
    private readonly itunesSearch: ItunesSearchService,
  ) {}

  /**
   * Connect a podcast show by RSS feed URL.
   * Parses all historical episodes and indexes them into the database.
   */
  async connectShow(
    workspaceId: string,
    input: ConnectPodcastDto,
    customFetch: typeof fetch = fetch,
  ): Promise<PodcastShowViewDto> {
    const feedUrl = input.feedUrl.trim();
    if (!feedUrl.startsWith("http://") && !feedUrl.startsWith("https://")) {
      throw new BadRequestException("Podcast feed URL must start with http:// or https://");
    }

    // Verify workspace exists
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (!workspace) {
      throw new NotFoundException(`Workspace ${workspaceId} not found`);
    }

    // Check if this feed is already connected in this workspace
    const existing = await this.prisma.podcastShow.findUnique({
      where: { feedUrl },
    });
    if (existing && existing.workspaceId !== workspaceId) {
      throw new ConflictException("This podcast feed is already connected in another workspace");
    }

    // Fetch the RSS feed
    let xmlContent = "";
    let etag: string | undefined = undefined;
    try {
      const response = await customFetch(feedUrl, {
        headers: {
          "User-Agent": "Aksharo-Podcast-Engine/1.0",
          Accept: "application/rss+xml, application/xml, text/xml, */*",
        },
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        throw new BadRequestException(
          `Failed to fetch podcast feed (HTTP ${response.status}): ${response.statusText}`,
        );
      }

      etag = response.headers.get("etag") || undefined;
      xmlContent = await response.text();
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Unable to reach podcast feed URL: ${err?.message}`);
    }

    // Parse RSS XML
    const parsedFeed = this.rssParser.parseFeed(xmlContent);

    // Upsert PodcastShow
    const show = await this.prisma.podcastShow.upsert({
      where: { feedUrl },
      create: {
        workspaceId,
        title: parsedFeed.title,
        feedUrl,
        author: parsedFeed.author,
        imageUrl: parsedFeed.imageUrl,
        lastBuildDate: parsedFeed.lastBuildDate,
        etag,
        autoRepurpose: input.autoRepurpose ?? true,
      },
      update: {
        workspaceId,
        title: parsedFeed.title,
        author: parsedFeed.author,
        imageUrl: parsedFeed.imageUrl,
        lastBuildDate: parsedFeed.lastBuildDate,
        etag,
        autoRepurpose: input.autoRepurpose ?? true,
      },
    });

    // Index all parsed episodes
    for (const ep of parsedFeed.episodes) {
      await this.prisma.podcastEpisode.upsert({
        where: { guid: ep.guid },
        create: {
          showId: show.id,
          guid: ep.guid,
          title: ep.title,
          audioUrl: ep.audioUrl,
          durationSec: ep.durationSec,
          publishedAt: ep.publishedAt,
          description: ep.description,
          summary: ep.summary,
          chapters: ep.chapters as any,
        },
        update: {
          title: ep.title,
          audioUrl: ep.audioUrl,
          durationSec: ep.durationSec,
          publishedAt: ep.publishedAt,
          description: ep.description,
          summary: ep.summary,
          chapters: ep.chapters as any,
        },
      });
    }

    return this.getShow(workspaceId, show.id);
  }

  /**
   * List all connected podcast shows for a workspace.
   */
  async listShows(workspaceId: string): Promise<PodcastShowViewDto[]> {
    const shows = await this.prisma.podcastShow.findMany({
      where: { workspaceId },
      include: {
        episodes: {
          orderBy: { publishedAt: "desc" },
          take: 10,
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return shows.map((s) => ({
      id: s.id,
      workspaceId: s.workspaceId,
      title: s.title,
      feedUrl: s.feedUrl,
      author: s.author,
      imageUrl: s.imageUrl,
      lastBuildDate: s.lastBuildDate?.toISOString() ?? null,
      autoRepurpose: s.autoRepurpose,
      episodeCount: s.episodes.length,
      episodes: s.episodes.map(this.mapEpisode),
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    }));
  }

  /**
   * Get a single podcast show with its complete episode catalog.
   */
  async getShow(workspaceId: string, showId: string): Promise<PodcastShowViewDto> {
    const show = await this.prisma.podcastShow.findFirst({
      where: { id: showId, workspaceId },
      include: {
        episodes: {
          orderBy: { publishedAt: "desc" },
        },
      },
    });

    if (!show) {
      throw new NotFoundException(`Podcast show ${showId} not found in this workspace`);
    }

    return {
      id: show.id,
      workspaceId: show.workspaceId,
      title: show.title,
      feedUrl: show.feedUrl,
      author: show.author,
      imageUrl: show.imageUrl,
      lastBuildDate: show.lastBuildDate?.toISOString() ?? null,
      autoRepurpose: show.autoRepurpose,
      episodeCount: show.episodes.length,
      episodes: show.episodes.map(this.mapEpisode),
      createdAt: show.createdAt.toISOString(),
      updatedAt: show.updatedAt.toISOString(),
    };
  }

  /**
   * Update show configuration (e.g. toggle autoRepurpose).
   */
  async updateShow(
    workspaceId: string,
    showId: string,
    input: UpdatePodcastShowDto,
  ): Promise<PodcastShowViewDto> {
    const show = await this.prisma.podcastShow.findFirst({
      where: { id: showId, workspaceId },
    });
    if (!show) {
      throw new NotFoundException(`Podcast show ${showId} not found`);
    }

    await this.prisma.podcastShow.update({
      where: { id: showId },
      data: {
        ...(input.autoRepurpose !== undefined ? { autoRepurpose: input.autoRepurpose } : {}),
      },
    });

    return this.getShow(workspaceId, showId);
  }

  /**
   * Disconnect/delete a podcast show from workspace.
   */
  async deleteShow(workspaceId: string, showId: string): Promise<{ deleted: boolean }> {
    const show = await this.prisma.podcastShow.findFirst({
      where: { id: showId, workspaceId },
    });
    if (!show) {
      throw new NotFoundException(`Podcast show ${showId} not found`);
    }

    await this.prisma.podcastShow.delete({
      where: { id: showId },
    });

    return { deleted: true };
  }

  /**
   * Sync an RSS feed, checking for newly released episodes.
   * Utilizes conditional HTTP requests (ETag & If-Modified-Since).
   */
  async syncFeed(
    showId: string,
    customFetch: typeof fetch = fetch,
  ): Promise<{ updated: boolean; newEpisodes: number; episodes: PodcastEpisodeViewDto[] }> {
    const show = await this.prisma.podcastShow.findUnique({
      where: { id: showId },
      include: { episodes: { select: { guid: true } } },
    });
    if (!show) {
      throw new NotFoundException(`Podcast show ${showId} not found`);
    }

    const headers: Record<string, string> = {
      "User-Agent": "Aksharo-Podcast-Engine/1.0",
      Accept: "application/rss+xml, application/xml, text/xml, */*",
    };
    if (show.etag) {
      headers["If-None-Match"] = show.etag;
    }
    if (show.lastBuildDate) {
      headers["If-Modified-Since"] = show.lastBuildDate.toUTCString();
    }

    try {
      const response = await customFetch(show.feedUrl, {
        headers,
        signal: AbortSignal.timeout(12000),
      });

      // 304 Not Modified: Nothing has changed
      if (response.status === 304) {
        this.logger.debug(`Feed for show "${show.title}" is unmodified (HTTP 304)`);
        return { updated: false, newEpisodes: 0, episodes: [] };
      }

      if (!response.ok) {
        this.logger.warn(`Failed to sync feed for show "${show.title}": HTTP ${response.status}`);
        return { updated: false, newEpisodes: 0, episodes: [] };
      }

      const newEtag = response.headers.get("etag") || show.etag;
      const xml = await response.text();
      const parsed = this.rssParser.parseFeed(xml);

      const existingGuids = new Set(show.episodes.map((e) => e.guid));
      const newItems = parsed.episodes.filter((e) => !existingGuids.has(e.guid));

      const createdEpisodes: any[] = [];
      for (const item of newItems) {
        const row = await this.prisma.podcastEpisode.create({
          data: {
            showId: show.id,
            guid: item.guid,
            title: item.title,
            audioUrl: item.audioUrl,
            durationSec: item.durationSec,
            publishedAt: item.publishedAt,
            description: item.description,
            summary: item.summary,
            chapters: item.chapters as any,
          },
        });
        createdEpisodes.push(row);
      }

      // Update show build date and etag
      await this.prisma.podcastShow.update({
        where: { id: show.id },
        data: {
          lastBuildDate: parsed.lastBuildDate || new Date(),
          etag: newEtag,
          imageUrl: parsed.imageUrl || show.imageUrl,
          title: parsed.title || show.title,
        },
      });

      // If auto-repurpose is enabled and new episodes were detected, automatically repurpose them
      if (show.autoRepurpose && createdEpisodes.length > 0) {
        for (const ep of createdEpisodes) {
          try {
            await this.repurposeEpisode(show.workspaceId, "system", ep.id);
          } catch (err: any) {
            this.logger.error(`Auto-repurpose failed for episode ${ep.id}: ${err?.message}`);
          }
        }
      }

      return {
        updated: true,
        newEpisodes: createdEpisodes.length,
        episodes: createdEpisodes.map(this.mapEpisode),
      };
    } catch (err: any) {
      this.logger.error(`Error syncing feed for show "${show.title}": ${err?.message}`);
      return { updated: false, newEpisodes: 0, episodes: [] };
    }
  }

  /**
   * Periodic poller: watches all active podcast shows with autoRepurpose=true.
   */
  async pollActiveShows(customFetch: typeof fetch = fetch): Promise<{ checked: number; newEpisodes: number }> {
    const activeShows = await this.prisma.podcastShow.findMany({
      where: { autoRepurpose: true },
    });

    let totalNew = 0;
    for (const show of activeShows) {
      const result = await this.syncFeed(show.id, customFetch);
      totalNew += result.newEpisodes;
    }

    return { checked: activeShows.length, newEpisodes: totalNew };
  }

  /**
   * 1-Click Repurpose for an episode:
   * Creates a Project, seeds highlight boundaries from parsed chapters, and links to episode.
   */
  async repurposeEpisode(
    workspaceId: string,
    userId: string,
    episodeId: string,
    options?: RepurposeEpisodeDto,
  ): Promise<{ projectId: string; episodeId: string; status: string }> {
    const episode = await this.prisma.podcastEpisode.findUnique({
      where: { id: episodeId },
      include: { show: true },
    });

    if (!episode) {
      throw new NotFoundException(`Episode ${episodeId} not found`);
    }

    if (episode.show.workspaceId !== workspaceId) {
      throw new NotFoundException(`Episode ${episodeId} does not belong to this workspace`);
    }

    // If already processed and project exists, return it
    if (episode.isProcessed && episode.projectId) {
      return {
        projectId: episode.projectId,
        episodeId: episode.id,
        status: "READY",
      };
    }

    const projectId = ulid();

    // 1. Create Project
    await this.prisma.project.create({
      data: {
        id: projectId,
        workspaceId,
        title: episode.title,
        status: "draft",
        aspect: "r9x16",
        sourceLanguage: options?.sourceLanguage === "auto" ? "hi" : (options?.sourceLanguage ?? "hi"),
        durationMs: episode.durationSec ? Math.round(episode.durationSec * 1000) : 0,
        createdBy: userId,
      },
    });

    // 2. Seed chapters from RSS into TranscriptChapter table (User Story 3)
    const rawChapters = Array.isArray(episode.chapters) ? (episode.chapters as any[]) : [];
    for (const ch of rawChapters) {
      if (ch.title && typeof ch.startSec === "number") {
        const startMs = Math.round(ch.startSec * 1000);
        const endMs =
          typeof ch.endSec === "number"
            ? Math.round(ch.endSec * 1000)
            : episode.durationSec
            ? Math.round(episode.durationSec * 1000)
            : startMs + 60000;

        await this.prisma.transcriptChapter.create({
          data: {
            id: ulid(),
            projectId,
            title: String(ch.title),
            startMs,
            endMs,
          },
        });
      }
    }

    // 3. Mark episode as processed and link project
    await this.prisma.podcastEpisode.update({
      where: { id: episode.id },
      data: {
        isProcessed: true,
        projectId,
      },
    });

    return {
      projectId,
      episodeId: episode.id,
      status: "READY",
    };
  }

  /**
   * Search iTunes directory.
   */
  async searchPodcasts(query: string, limit?: number) {
    return this.itunesSearch.search(query, limit);
  }

  private mapEpisode(ep: any): PodcastEpisodeViewDto {
    return {
      id: ep.id,
      showId: ep.showId,
      guid: ep.guid,
      title: ep.title,
      audioUrl: ep.audioUrl,
      durationSec: ep.durationSec,
      publishedAt: ep.publishedAt.toISOString(),
      isProcessed: ep.isProcessed,
      projectId: ep.projectId,
      description: ep.description,
      summary: ep.summary,
      chapters: Array.isArray(ep.chapters) ? ep.chapters : undefined,
      createdAt: ep.createdAt.toISOString(),
    };
  }
}

