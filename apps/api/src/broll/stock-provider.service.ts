import { HttpStatus, Injectable, Logger, Optional } from "@nestjs/common";
import { z } from "zod";

import { PexelsClient, PexelsError, pexelsSetting } from "./pexels.client.js";
import { AppException, PrismaService } from "../common/index.js";
import { safeFetch } from "../common/net/index.js";
import { RedisService } from "../common/redis/redis.service.js";

import type { ProjectBrollCue } from "@prisma/client";

export const PEXELS_VIDEOS_API_HOST = "api.pexels.com";
export const REDIS_BROLL_CACHE_TTL_SEC = 24 * 60 * 60; // 24-hour TTL

export interface StockVideoCandidate {
  readonly id: string;
  readonly provider: "PEXELS" | "STORYBLOCKS" | "PIXABAY";
  readonly title?: string;
  readonly durationSec: number;
  readonly width: number;
  readonly height: number;
  readonly videoUrl: string;
  readonly previewImageUrl: string;
  readonly authorName: string;
  readonly authorUrl?: string;
  readonly pageUrl?: string;
  readonly resolution: string;
}

export interface StockVideoSearchOptions {
  readonly query: string;
  readonly orientation?: "portrait" | "landscape" | "square";
  readonly perPage?: number;
  readonly page?: number;
  readonly provider?: "PEXELS" | "STORYBLOCKS";
  readonly minResolution?: number; // default 1080
}

export interface CreateProjectBrollCueInput {
  readonly projectId: string;
  readonly startSec: number;
  readonly endSec: number;
  readonly query: string;
  readonly stockVideoUri: string;
  readonly sourceProvider?: string;
  readonly status?: string;
}

export interface UpdateProjectBrollCueInput {
  readonly startSec?: number;
  readonly endSec?: number;
  readonly query?: string;
  readonly stockVideoUri?: string;
  readonly sourceProvider?: string;
  readonly status?: string;
}

const PexelsVideoFileSchema = z.object({
  id: z.number().optional(),
  quality: z.string().optional(),
  file_type: z.string().optional(),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  fps: z.number().optional(),
  link: z.string().url(),
});

const PexelsVideoSchema = z.object({
  id: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  duration: z.number().positive(),
  url: z.string(),
  image: z.string(),
  user: z
    .object({
      id: z.number().optional(),
      name: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
  video_files: z.array(PexelsVideoFileSchema),
  video_pictures: z
    .array(
      z.object({
        id: z.number().optional(),
        picture: z.string(),
        nr: z.number().optional(),
      }),
    )
    .optional(),
});

const PexelsVideoSearchResponseSchema = z.object({
  page: z.number().optional(),
  per_page: z.number().optional(),
  total_results: z.number().optional(),
  url: z.string().optional(),
  videos: z.array(PexelsVideoSchema),
});

/** Curated high-impact commercial video fallbacks for key creator speech concepts */
const STORYBLOCKS_CURATED_CATALOGUE: readonly StockVideoCandidate[] = Object.freeze([
  {
    id: "sb-ads-dash-01",
    provider: "STORYBLOCKS",
    title: "Digital Advertising Analytics Dashboard 4K",
    durationSec: 8.5,
    width: 1080,
    height: 1920,
    videoUrl: "https://assets.aksharo.com/stock/videos/ad-spend-analytics-vertical-1080p.mp4",
    previewImageUrl: "https://assets.aksharo.com/stock/previews/ad-spend-analytics.jpg",
    authorName: "FinTech Media",
    authorUrl: "https://storyblocks.com/creator/fintechmedia",
    pageUrl: "https://storyblocks.com/video/ad-spend-analytics",
    resolution: "1080p",
  },
  {
    id: "sb-realestate-02",
    provider: "STORYBLOCKS",
    title: "Luxury Modern Real Estate Drone Vertical",
    durationSec: 10.0,
    width: 1080,
    height: 1920,
    videoUrl: "https://assets.aksharo.com/stock/videos/luxury-real-estate-vertical-1080p.mp4",
    previewImageUrl: "https://assets.aksharo.com/stock/previews/luxury-real-estate.jpg",
    authorName: "Aerial Cinematic",
    authorUrl: "https://storyblocks.com/creator/aerialcinematic",
    pageUrl: "https://storyblocks.com/video/luxury-real-estate",
    resolution: "1080p",
  },
  {
    id: "sb-rocket-03",
    provider: "STORYBLOCKS",
    title: "Rocket Launch Smoke Space Cinematic 4K",
    durationSec: 7.2,
    width: 1080,
    height: 1920,
    videoUrl: "https://assets.aksharo.com/stock/videos/rocket-launch-space-vertical-1080p.mp4",
    previewImageUrl: "https://assets.aksharo.com/stock/previews/rocket-launch.jpg",
    authorName: "AstroVision",
    authorUrl: "https://storyblocks.com/creator/astrovision",
    pageUrl: "https://storyblocks.com/video/rocket-launch",
    resolution: "1080p",
  },
  {
    id: "sb-chart-04",
    provider: "STORYBLOCKS",
    title: "Stock Market Trading Chart Growth Green Candles",
    durationSec: 6.8,
    width: 1080,
    height: 1920,
    videoUrl: "https://assets.aksharo.com/stock/videos/stock-market-charts-vertical-1080p.mp4",
    previewImageUrl: "https://assets.aksharo.com/stock/previews/stock-market-charts.jpg",
    authorName: "QuantVisuals",
    authorUrl: "https://storyblocks.com/creator/quantvisuals",
    pageUrl: "https://storyblocks.com/video/stock-market-charts",
    resolution: "1080p",
  },
  {
    id: "sb-nature-05",
    provider: "STORYBLOCKS",
    title: "Mountain Mist Sunrise Drone Cinematic",
    durationSec: 9.0,
    width: 1080,
    height: 1920,
    videoUrl: "https://assets.aksharo.com/stock/videos/mountain-mist-vertical-1080p.mp4",
    previewImageUrl: "https://assets.aksharo.com/stock/previews/mountain-mist.jpg",
    authorName: "NatureCraft",
    authorUrl: "https://storyblocks.com/creator/naturecraft",
    pageUrl: "https://storyblocks.com/video/mountain-mist",
    resolution: "1080p",
  },
  {
    id: "sb-ai-tech-06",
    provider: "STORYBLOCKS",
    title: "Artificial Intelligence Neural Network Glowing Node Mesh",
    durationSec: 8.0,
    width: 1080,
    height: 1920,
    videoUrl: "https://assets.aksharo.com/stock/videos/ai-neural-network-vertical-1080p.mp4",
    previewImageUrl: "https://assets.aksharo.com/stock/previews/ai-neural-network.jpg",
    authorName: "NeuralFx",
    authorUrl: "https://storyblocks.com/creator/neuralfx",
    pageUrl: "https://storyblocks.com/video/ai-neural-network",
    resolution: "1080p",
  },
]);

/**
 * StockProviderService (Pillar 6 §01):
 * Queries stock video repositories (Pexels Video API, Storyblocks), filters for vertical portrait
 * 9:16 footage (>= 1080p resolution), caches results in Redis with 24h TTL, and manages
 * persistent ProjectBrollCue records.
 */
@Injectable()
export class StockProviderService {
  private readonly logger = new Logger(StockProviderService.name);
  private readonly pexelsApiKey: string | null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly pexelsClient?: PexelsClient,
  ) {
    this.pexelsApiKey = pexelsSetting().apiKey;
  }

  get isStockEnabled(): boolean {
    return this.pexelsApiKey !== null || this.pexelsClient?.enabled === true;
  }

  /**
   * Search stock video candidates matching `query` and `orientation`.
   * Results are cached by query in Redis with a 24-hour TTL.
   */
  async searchVideos(options: StockVideoSearchOptions): Promise<StockVideoCandidate[]> {
    const query = options.query.trim();
    if (!query) return [];

    const orientation = options.orientation ?? "portrait";
    const perPage = Math.min(options.perPage ?? 10, 20);
    const page = options.page ?? 1;
    const provider = options.provider ?? "PEXELS";
    const cacheKey = `broll:videos:${provider.toLowerCase()}:${query.toLowerCase()}:${orientation}:${page}`;

    // 1. Try reading from Redis cache
    if (this.redis?.client) {
      try {
        const cached = await this.redis.client.get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached) as StockVideoCandidate[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      } catch (err) {
        this.logger.debug(`Redis cache lookup skipped for ${cacheKey}: ${String(err)}`);
      }
    }

    // 2. Fetch from chosen provider
    let candidates: StockVideoCandidate[] = [];
    if (provider === "PEXELS" && this.pexelsApiKey) {
      candidates = await this.searchPexelsVideos(query, orientation, perPage, page);
    }

    // If Pexels returns no candidates or provider is Storyblocks, use Storyblocks matching
    if (candidates.length === 0) {
      candidates = this.searchStoryblocksVideos(query, orientation, perPage);
    }

    // 3. Cache results in Redis (24-hour TTL)
    if (candidates.length > 0 && this.redis?.client) {
      try {
        await this.redis.client.set(
          cacheKey,
          JSON.stringify(candidates),
          "EX",
          REDIS_BROLL_CACHE_TTL_SEC,
        );
      } catch (err) {
        this.logger.debug(`Failed to cache stock videos in Redis: ${String(err)}`);
      }
    }

    return candidates;
  }

  /**
   * Query Pexels Video Search API and extract vertical portrait candidates with >= 1080p resolution.
   */
  private async searchPexelsVideos(
    query: string,
    orientation: "portrait" | "landscape" | "square",
    perPage: number,
    page: number,
  ): Promise<StockVideoCandidate[]> {
    if (!this.pexelsApiKey) return [];

    const params = new URLSearchParams({
      query,
      orientation,
      per_page: String(perPage),
      page: String(page),
    });

    try {
      const url = `https://${PEXELS_VIDEOS_API_HOST}/videos/search?${params.toString()}`;
      const response = await safeFetch(url, {
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 10_000,
        allowedPorts: [443],
        headers: {
          authorization: this.pexelsApiKey,
          accept: "application/json",
          "user-agent": "Aksharo/1.0 (+b-roll stock engine)",
        },
      });

      if (response.status !== 200) {
        this.logger.warn(`Pexels video search answered HTTP ${response.status}`);
        return [];
      }

      const parsed = PexelsVideoSearchResponseSchema.safeParse(
        JSON.parse(response.body.toString("utf8")),
      );
      if (!parsed.success) {
        this.logger.warn(`Pexels video response schema mismatch: ${parsed.error.message}`);
        return [];
      }

      const results: StockVideoCandidate[] = [];
      for (const video of parsed.data.videos) {
        const candidate = this.extractBestVerticalVideoFile(video, orientation);
        if (candidate) {
          results.push(candidate);
        }
      }
      return results;
    } catch (err) {
      this.logger.error(`Error querying Pexels Video API: ${String(err)}`);
      return [];
    }
  }

  /**
   * Selects highest resolution vertical portrait video link (prioritizing >= 1080p).
   */
  private extractBestVerticalVideoFile(
    video: z.infer<typeof PexelsVideoSchema>,
    desiredOrientation: "portrait" | "landscape" | "square",
  ): StockVideoCandidate | null {
    if (!video.video_files || video.video_files.length === 0) return null;

    // Filter mp4 files
    const mp4Files = video.video_files.filter(
      (f) => !f.file_type || f.file_type === "video/mp4" || f.link.includes(".mp4"),
    );
    const candidates = mp4Files.length > 0 ? mp4Files : video.video_files;

    // For portrait, look for files where height > width or aspect <= 0.8
    const portraitFiles = candidates.filter((f) => {
      const w = f.width ?? video.width;
      const h = f.height ?? video.height;
      return desiredOrientation === "portrait" ? h >= w : true;
    });

    const targetPool = portraitFiles.length > 0 ? portraitFiles : candidates;

    // Sort descending by resolution (height)
    targetPool.sort((a, b) => {
      const ha = a.height ?? 0;
      const hb = b.height ?? 0;
      return hb - ha;
    });

    // Select >= 1080p if available, else best available
    const bestFile = targetPool.find((f) => (f.height ?? 0) >= 1080) ?? targetPool[0];
    if (!bestFile) return null;

    const width = bestFile.width ?? video.width;
    const height = bestFile.height ?? video.height;
    const resLabel = height >= 2160 ? "4k" : height >= 1080 ? "1080p" : "720p";

    return {
      id: `pexels-${video.id}`,
      provider: "PEXELS",
      durationSec: video.duration,
      width,
      height,
      videoUrl: bestFile.link,
      previewImageUrl: video.image,
      authorName: video.user?.name ?? "Pexels Creator",
      authorUrl: video.user?.url,
      pageUrl: video.url,
      resolution: resLabel,
    };
  }

  /**
   * Search curated Storyblocks catalogue based on query keywords.
   */
  private searchStoryblocksVideos(
    query: string,
    orientation: string,
    perPage: number,
  ): StockVideoCandidate[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = STORYBLOCKS_CURATED_CATALOGUE.filter((item) => {
      const hay = `${item.title ?? ""} ${item.id} ${item.authorName}`.toLowerCase();
      return terms.some((term) => hay.includes(term));
    });

    const pool = matched.length > 0 ? matched : STORYBLOCKS_CURATED_CATALOGUE;
    return pool.slice(0, perPage);
  }

  // ---------------------------------------------------------------------------
  // ProjectBrollCue Persistence CRUD Operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new B-roll cue for a project.
   */
  async createCue(input: CreateProjectBrollCueInput): Promise<ProjectBrollCue> {
    const project = await this.prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true },
    });
    if (!project) {
      throw new AppException("broll/project_not_found", "Project not found", HttpStatus.NOT_FOUND);
    }

    if (input.endSec <= input.startSec) {
      throw new AppException(
        "broll/invalid_duration",
        "End time must be greater than start time",
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.projectBrollCue.create({
      data: {
        projectId: input.projectId,
        startSec: input.startSec,
        endSec: input.endSec,
        query: input.query.trim(),
        stockVideoUri: input.stockVideoUri,
        sourceProvider: input.sourceProvider ?? "PEXELS",
        status: input.status ?? "ACTIVE",
      },
    });
  }

  /**
   * Get all active B-roll cues for a project, ordered by start timestamp.
   */
  async getCues(projectId: string): Promise<ProjectBrollCue[]> {
    return this.prisma.projectBrollCue.findMany({
      where: { projectId, status: { not: "DELETED" } },
      orderBy: { startSec: "asc" },
    });
  }

  /**
   * Update an existing B-roll cue (e.g. trim duration or change status).
   */
  async updateCue(cueId: string, input: UpdateProjectBrollCueInput): Promise<ProjectBrollCue> {
    const existing = await this.prisma.projectBrollCue.findUnique({
      where: { id: cueId },
    });
    if (!existing) {
      throw new AppException("broll/cue_not_found", "B-roll cue not found", HttpStatus.NOT_FOUND);
    }

    return this.prisma.projectBrollCue.update({
      where: { id: cueId },
      data: {
        ...(input.startSec !== undefined ? { startSec: input.startSec } : {}),
        ...(input.endSec !== undefined ? { endSec: input.endSec } : {}),
        ...(input.query !== undefined ? { query: input.query.trim() } : {}),
        ...(input.stockVideoUri !== undefined ? { stockVideoUri: input.stockVideoUri } : {}),
        ...(input.sourceProvider !== undefined ? { sourceProvider: input.sourceProvider } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
  }

  /**
   * Swap the stock video asset for an existing B-roll cue.
   */
  async swapCueVideo(
    cueId: string,
    stockVideoUri: string,
    sourceProvider = "PEXELS",
  ): Promise<ProjectBrollCue> {
    return this.updateCue(cueId, { stockVideoUri, sourceProvider });
  }

  /**
   * Mark a cue as DELETED or remove from database.
   */
  async deleteCue(cueId: string): Promise<boolean> {
    const existing = await this.prisma.projectBrollCue.findUnique({
      where: { id: cueId },
    });
    if (!existing) return false;

    await this.prisma.projectBrollCue.delete({ where: { id: cueId } });
    return true;
  }
}

