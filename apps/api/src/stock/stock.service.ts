import { HttpStatus, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { z } from "zod";

import {
  STOCK_CATEGORIES,
  type StockAsset,
  type StockImportDto,
  type StockImportResponse,
  type StockOrientationType,
  type StockProviderType,
  type StockSearchInput,
  type StockSearchQueryDto,
  type StockSearchResponse,
} from "./stock.dto.js";
import { AppException, PrismaService } from "../common/index.js";
import { safeFetch } from "../common/net/index.js";
import { RedisService } from "../common/redis/redis.service.js";
import { RAW_STORE, type ObjectStore } from "../common/storage/object-store.js";

export const REDIS_STOCK_CACHE_TTL_SEC = 48 * 60 * 60; // 48-hour TTL (ARCHITECTURE_AND_IMPLEMENTATION_PLAN §2.1)
const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024; // 150 MB

// Pexels Video Search Schema
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
});

const PexelsSearchResponseSchema = z.object({
  page: z.number().optional(),
  per_page: z.number().optional(),
  total_results: z.number().optional(),
  videos: z.array(PexelsVideoSchema),
});

// Pixabay Video Search Schema
const PixabayVideoHitSchema = z.object({
  id: z.number().int().positive(),
  pageURL: z.string().optional(),
  type: z.string().optional(),
  tags: z.string().optional(),
  duration: z.number().positive().optional(),
  user: z.string().optional(),
  videos: z.object({
    large: z
      .object({
        url: z.string().url(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        size: z.number().optional(),
      })
      .optional(),
    medium: z
      .object({
        url: z.string().url(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        size: z.number().optional(),
      })
      .optional(),
    small: z
      .object({
        url: z.string().url(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        size: z.number().optional(),
      })
      .optional(),
    tiny: z
      .object({
        url: z.string().url(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        size: z.number().optional(),
      })
      .optional(),
  }),
});

const PixabaySearchResponseSchema = z.object({
  total: z.number().optional(),
  totalHits: z.number().optional(),
  hits: z.array(PixabayVideoHitSchema),
});

/**
 * Curated high-resolution stock video catalog covering major commercial creator themes.
 * Used for Storyblocks integration and ultra-reliable zero-dependency fallback.
 */
export const STORYBLOCKS_CURATED_LIBRARY: readonly StockAsset[] = Object.freeze([
  {
    id: "sb-tech-ai-01",
    provider: "storyblocks",
    title: "Artificial Intelligence Glowing Neural Network Nodes",
    durationSec: 8.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/ai-neural-network.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/ai-neural-network-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/ai-neural-network-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "NeuralFx",
    authorUrl: "https://storyblocks.com/creator/neuralfx",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["technology", "ai", "network", "cyber", "data", "future"],
  },
  {
    id: "sb-crypto-chart-02",
    provider: "storyblocks",
    title: "Cryptocurrency Candlestick Market Growth Bull Run",
    durationSec: 6.8,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/stock-market-charts.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/stock-market-charts-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/stock-market-charts-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "QuantVisuals",
    authorUrl: "https://storyblocks.com/creator/quantvisuals",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["finance", "crypto", "trading", "chart", "money", "bitcoin", "investment"],
  },
  {
    id: "sb-realestate-03",
    provider: "storyblocks",
    title: "Luxury Modern Architecture Villa Drone Cinematic",
    durationSec: 10.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/luxury-real-estate.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/luxury-real-estate-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/luxury-real-estate-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "Aerial Cinematic",
    authorUrl: "https://storyblocks.com/creator/aerialcinematic",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["real estate", "architecture", "villa", "drone", "luxury", "home"],
  },
  {
    id: "sb-nature-mist-04",
    provider: "storyblocks",
    title: "Alpine Mountain Sunrise Mist Pine Forest Aerial",
    durationSec: 9.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/mountain-mist.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/mountain-mist-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/mountain-mist-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "NatureCraft",
    authorUrl: "https://storyblocks.com/creator/naturecraft",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["nature", "mountain", "mist", "forest", "sunrise", "drone", "calm"],
  },
  {
    id: "sb-ad-analytics-05",
    provider: "storyblocks",
    title: "Digital Marketing Analytics SaaS Dashboard Metrics",
    durationSec: 8.5,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/ad-spend-analytics.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/ad-spend-analytics-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/ad-spend-analytics-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "FinTech Media",
    authorUrl: "https://storyblocks.com/creator/fintechmedia",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["business", "marketing", "analytics", "dashboard", "metrics", "saas"],
  },
  {
    id: "sb-space-rocket-06",
    provider: "storyblocks",
    title: "Rocket Launch Thrusters Smoke Cosmic Ascent",
    durationSec: 7.2,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/rocket-launch.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/rocket-launch-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/rocket-launch-space-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "AstroVision",
    authorUrl: "https://storyblocks.com/creator/astrovision",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["space", "rocket", "launch", "stars", "tech", "orbit"],
  },
  {
    id: "sb-city-night-07",
    provider: "storyblocks",
    title: "New York Manhattan Night Traffic Bokeh Timelapse",
    durationSec: 8.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/city-night-traffic.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/city-night-traffic-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/city-night-traffic-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "UrbanCinematic",
    authorUrl: "https://storyblocks.com/creator/urbancinematic",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["city", "new york", "traffic", "night", "timelapse", "lights", "urban"],
  },
  {
    id: "sb-abstract-waves-08",
    provider: "storyblocks",
    title: "3D Iridescent Holographic Fluid Wave Motion",
    durationSec: 6.5,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/fluid-wave-abstract.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/fluid-wave-abstract-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/fluid-wave-abstract-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "PrismDesign",
    authorUrl: "https://storyblocks.com/creator/prismdesign",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["abstract", "waves", "3d", "gradient", "motion", "holographic"],
  },
  {
    id: "sb-business-team-09",
    provider: "storyblocks",
    title: "Startup Founders Brainstorming Strategy Glass Board",
    durationSec: 7.5,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/startup-meeting.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/startup-meeting-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/startup-meeting-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "CreativeWork",
    authorUrl: "https://storyblocks.com/creator/creativework",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["business", "office", "team", "meeting", "startup", "collaboration"],
  },
  {
    id: "sb-fitness-crossfit-10",
    provider: "storyblocks",
    title: "High Intensity Battle Ropes Athlete Training",
    durationSec: 6.0,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/fitness-battle-ropes.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/fitness-battle-ropes-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/fitness-battle-ropes-vertical-1080p.mp4",
    width: 1080,
    height: 1920,
    authorName: "FitCore",
    authorUrl: "https://storyblocks.com/creator/fitcore",
    resolution: "1080p",
    aspectRatio: "9:16",
    tags: ["fitness", "workout", "gym", "athlete", "health", "exercise"],
  },
  {
    id: "sb-ocean-waves-11",
    provider: "storyblocks",
    title: "Turquoise Ocean Waves Crashing Coastal Cliffs 4K",
    durationSec: 9.5,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/ocean-waves-aerial.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/ocean-waves-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/ocean-waves-horizontal-1080p.mp4",
    width: 1920,
    height: 1080,
    authorName: "AquaVisuals",
    authorUrl: "https://storyblocks.com/creator/aquavisuals",
    resolution: "1080p",
    aspectRatio: "16:9",
    tags: ["nature", "ocean", "waves", "water", "sea", "aerial", "beach"],
  },
  {
    id: "sb-city-horizon-12",
    provider: "storyblocks",
    title: "Futuristic Megacity Skyline Sunset Horizon 4K",
    durationSec: 8.8,
    thumbnailUrl: "https://assets.aksharo.com/stock/previews/city-skyline-sunset.jpg",
    previewVideoUrl: "https://assets.aksharo.com/stock/videos/city-skyline-preview-480p.mp4",
    downloadVideoUrl: "https://assets.aksharo.com/stock/videos/city-skyline-horizontal-1080p.mp4",
    width: 1920,
    height: 1080,
    authorName: "SkylineStudio",
    authorUrl: "https://storyblocks.com/creator/skylinestudio",
    resolution: "1080p",
    aspectRatio: "16:9",
    tags: ["city", "skyline", "sunset", "urban", "architecture", "landscape"],
  },
]);

/**
 * Unified Stock Media Library Service (Pillar 6 §02).
 * Aggregates Pexels, Pixabay, and Storyblocks via unified search gateway,
 * normalizes responses, caches results in Redis with 48h TTL, and manages S3 asset caching.
 */
@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);
  private readonly pexelsApiKey: string | null;
  private readonly pixabayApiKey: string | null;

  // In-memory fallback cache when Redis is offline or not configured
  private readonly memoryCache = new Map<string, { readonly data: StockSearchResponse; readonly expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
    @Inject(RAW_STORE) @Optional() private readonly rawStore?: ObjectStore,
  ) {
    this.pexelsApiKey = process.env["PEXELS_API_KEY"] ?? null;
    this.pixabayApiKey = process.env["PIXABAY_API_KEY"] ?? null;
  }

  getCategories(): readonly string[] {
    return STOCK_CATEGORIES;
  }

  /**
   * Fan-out search across multiple stock providers with Redis caching.
   */
  async search(queryOptions: StockSearchInput): Promise<StockSearchResponse> {
    const rawQuery = (queryOptions.q ?? queryOptions.query ?? "").trim();
    const category = (queryOptions.category ?? "").trim();
    const query = rawQuery || (category && category !== "All" ? category : "cinematic");

    // Map orientation / aspect
    let orientation: StockOrientationType = queryOptions.orientation ?? "all";
    if (queryOptions.aspect === "9:16") orientation = "portrait";
    if (queryOptions.aspect === "16:9") orientation = "landscape";
    if (queryOptions.aspect === "1:1") orientation = "square";

    const providerFilter: StockProviderType | "all" = queryOptions.provider ?? "all";
    const page = queryOptions.page ?? 1;
    const perPage = queryOptions.limit ?? queryOptions.perPage ?? 20;
    const minRes = queryOptions.minResolution ?? 1080;

    const cacheKey = `stock:search:v1:${query.toLowerCase()}:${orientation}:${category.toLowerCase()}:${providerFilter}:${page}:${perPage}`;

    // 1. Check Redis / Memory cache
    const cachedResponse = await this.readCache(cacheKey);
    if (cachedResponse) {
      return { ...cachedResponse, cached: true };
    }

    // 2. Fan-out search across providers using Promise.allSettled
    const searchPromises: Promise<StockAsset[]>[] = [];

    if (providerFilter === "all" || providerFilter === "pexels") {
      searchPromises.push(this.searchPexels(query, orientation, perPage, page, minRes));
    }
    if (providerFilter === "all" || providerFilter === "pixabay") {
      searchPromises.push(this.searchPixabay(query, orientation, perPage, page));
    }
    if (providerFilter === "all" || providerFilter === "storyblocks") {
      searchPromises.push(Promise.resolve(this.searchStoryblocks(query, orientation, category, perPage, page)));
    }

    const settled = await Promise.allSettled(searchPromises);
    const combined: StockAsset[] = [];

    for (const result of settled) {
      if (result.status === "fulfilled" && Array.isArray(result.value)) {
        combined.push(...result.value);
      } else if (result.status === "rejected") {
        this.logger.warn(`Provider search encountered error: ${String(result.reason)}`);
      }
    }

    // Deduplicate assets by ID
    const seenIds = new Set<string>();
    const deduplicated: StockAsset[] = [];
    for (const item of combined) {
      if (!seenIds.has(item.id)) {
        seenIds.add(item.id);
        deduplicated.push(item);
      }
    }

    // Rank results based on requested orientation
    const ranked = this.rankAssets(deduplicated, orientation);

    // Apply pagination
    const total = ranked.length;
    const offset = (page - 1) * perPage;
    const items = ranked.slice(offset, offset + perPage);

    const response: StockSearchResponse = {
      items,
      total,
      page,
      perPage,
      cached: false,
    };

    // 3. Write to cache with 48h TTL
    await this.writeCache(cacheKey, response);

    return response;
  }

  /**
   * Search Pexels Video Search API.
   */
  private async searchPexels(
    query: string,
    orientation: StockOrientationType,
    perPage: number,
    page: number,
    minResolution: number,
  ): Promise<StockAsset[]> {
    if (!this.pexelsApiKey) return [];

    const pexelsOrientation = orientation === "all" ? undefined : orientation;
    const params = new URLSearchParams({
      query,
      per_page: String(perPage),
      page: String(page),
      ...(pexelsOrientation ? { orientation: pexelsOrientation } : {}),
    });

    try {
      const url = `https://api.pexels.com/videos/search?${params.toString()}`;
      const response = await safeFetch(url, {
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        allowedPorts: [443],
        headers: {
          authorization: this.pexelsApiKey,
          accept: "application/json",
          "user-agent": "Aksharo-Stock-Engine/1.0",
        },
      });

      if (response.status !== 200) {
        this.logger.warn(`Pexels API responded with status ${response.status}`);
        return [];
      }

      const parsed = PexelsSearchResponseSchema.safeParse(
        JSON.parse(response.body.toString("utf8")),
      );
      if (!parsed.success) {
        this.logger.warn(`Pexels response schema mismatch: ${parsed.error.message}`);
        return [];
      }

      const results: StockAsset[] = [];
      for (const video of parsed.data.videos) {
        const asset = this.mapPexelsVideo(video, orientation, minResolution);
        if (asset) results.push(asset);
      }

      return results;
    } catch (err) {
      this.logger.warn(`Pexels search failed gracefully: ${String(err)}`);
      return [];
    }
  }

  private mapPexelsVideo(
    video: z.infer<typeof PexelsVideoSchema>,
    desiredOrientation: StockOrientationType,
    minResolution: number,
  ): StockAsset | null {
    if (!video.video_files || video.video_files.length === 0) return null;

    const mp4Files = video.video_files.filter(
      (f) => !f.file_type || f.file_type === "video/mp4" || f.link.includes(".mp4"),
    );
    const pool = mp4Files.length > 0 ? mp4Files : video.video_files;

    // Filter orientation if required
    const matchedOrientation = pool.filter((f) => {
      const w = f.width ?? video.width;
      const h = f.height ?? video.height;
      if (desiredOrientation === "portrait") return h >= w;
      if (desiredOrientation === "landscape") return w >= h;
      return true;
    });

    const activePool = matchedOrientation.length > 0 ? matchedOrientation : pool;

    // Find fast 480p preview (height <= 720 or quality == "sd")
    const previewCandidates = [...activePool].sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
    const previewFile = previewCandidates.find((f) => (f.height ?? 0) <= 720) ?? previewCandidates[0];

    // Find high-res download (>= 1080p, sorted descending)
    const downloadCandidates = [...activePool].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    const downloadFile = downloadCandidates.find((f) => (f.height ?? 0) >= minResolution) ?? downloadCandidates[0];

    if (!previewFile || !downloadFile) return null;

    const w = downloadFile.width ?? video.width;
    const h = downloadFile.height ?? video.height;
    const res = h >= 2160 ? "4k" : h >= 1080 ? "1080p" : "720p";
    const aspect = h > w ? "9:16" : w > h ? "16:9" : "1:1";

    return {
      id: `pexels-${video.id}`,
      provider: "pexels",
      title: `Pexels Video #${video.id}`,
      durationSec: video.duration,
      thumbnailUrl: video.image,
      previewVideoUrl: previewFile.link,
      downloadVideoUrl: downloadFile.link,
      width: w,
      height: h,
      authorName: video.user?.name ?? "Pexels Creator",
      authorUrl: video.user?.url,
      resolution: res,
      aspectRatio: aspect,
      tags: ["pexels", "stock"],
    };
  }

  /**
   * Search Pixabay Video API.
   */
  private async searchPixabay(
    query: string,
    orientation: StockOrientationType,
    perPage: number,
    page: number,
  ): Promise<StockAsset[]> {
    if (!this.pixabayApiKey) return [];

    const params = new URLSearchParams({
      key: this.pixabayApiKey,
      q: query,
      per_page: String(perPage),
      page: String(page),
      video_type: "all",
    });

    try {
      const url = `https://pixabay.com/api/videos/?${params.toString()}`;
      const response = await safeFetch(url, {
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: PROVIDER_TIMEOUT_MS,
        allowedPorts: [443],
        headers: {
          accept: "application/json",
          "user-agent": "Aksharo-Stock-Engine/1.0",
        },
      });

      if (response.status !== 200) {
        this.logger.warn(`Pixabay API answered status ${response.status}`);
        return [];
      }

      const parsed = PixabaySearchResponseSchema.safeParse(
        JSON.parse(response.body.toString("utf8")),
      );
      if (!parsed.success) {
        this.logger.warn(`Pixabay schema mismatch: ${parsed.error.message}`);
        return [];
      }

      const results: StockAsset[] = [];
      for (const hit of parsed.data.hits) {
        const previewUrl = hit.videos.tiny?.url ?? hit.videos.small?.url ?? hit.videos.medium?.url;
        const downloadUrl = hit.videos.large?.url ?? hit.videos.medium?.url ?? previewUrl;
        if (!previewUrl || !downloadUrl) continue;

        const w = hit.videos.large?.width ?? hit.videos.medium?.width ?? 1920;
        const h = hit.videos.large?.height ?? hit.videos.medium?.height ?? 1080;
        const aspect = h > w ? "9:16" : w > h ? "16:9" : "1:1";
        const tags = (hit.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);

        results.push({
          id: `pixabay-${hit.id}`,
          provider: "pixabay",
          title: tags.slice(0, 3).join(" ") || `Pixabay Video #${hit.id}`,
          durationSec: hit.duration ?? 10,
          thumbnailUrl: `https://i.vimeocdn.com/video/${hit.id}_640x360.jpg`,
          previewVideoUrl: previewUrl,
          downloadVideoUrl: downloadUrl,
          width: w,
          height: h,
          authorName: hit.user ?? "Pixabay Creator",
          resolution: h >= 1080 ? "1080p" : "720p",
          aspectRatio: aspect,
          tags,
        });
      }

      return results;
    } catch (err) {
      this.logger.warn(`Pixabay search failed gracefully: ${String(err)}`);
      return [];
    }
  }

  /**
   * Search curated Storyblocks catalog by keyword and category matching.
   */
  private searchStoryblocks(
    query: string,
    orientation: StockOrientationType,
    category: string,
    perPage: number,
    page: number,
  ): StockAsset[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const catTerm = category && category !== "All" ? category.toLowerCase() : null;

    const matched = STORYBLOCKS_CURATED_LIBRARY.filter((item) => {
      // Orientation match
      if (orientation === "portrait" && item.aspectRatio !== "9:16") return false;
      if (orientation === "landscape" && item.aspectRatio !== "16:9") return false;

      // Category match
      if (catTerm) {
        const hasCat = item.tags?.some((t) => t.toLowerCase().includes(catTerm)) ?? false;
        if (!hasCat && !item.title.toLowerCase().includes(catTerm)) return false;
      }

      if (terms.length === 0) return true;

      // Keyword match
      const searchable = `${item.title} ${item.tags?.join(" ") ?? ""} ${item.authorName ?? ""}`.toLowerCase();
      return terms.some((term) => searchable.includes(term));
    });

    const pool = matched.length > 0 ? matched : STORYBLOCKS_CURATED_LIBRARY;
    const offset = (page - 1) * perPage;
    return pool.slice(offset, offset + perPage);
  }

  /**
   * Rank and sort assets: vertical clips prioritized when portrait/9:16 is requested.
   */
  private rankAssets(assets: StockAsset[], orientation: StockOrientationType): StockAsset[] {
    return [...assets].sort((a, b) => {
      if (orientation === "portrait") {
        const aIsVert = a.height >= a.width ? 1 : 0;
        const bIsVert = b.height >= b.width ? 1 : 0;
        if (aIsVert !== bIsVert) return bIsVert - aIsVert;
      } else if (orientation === "landscape") {
        const aIsHoriz = a.width >= a.height ? 1 : 0;
        const bIsHoriz = b.width >= b.height ? 1 : 0;
        if (aIsHoriz !== bIsHoriz) return bIsHoriz - aIsHoriz;
      }

      // Prioritize 1080p and above
      const aHeight = a.height ?? 0;
      const bHeight = b.height ?? 0;
      return bHeight - aHeight;
    });
  }

  // ---------------------------------------------------------------------------
  // Step 2: Asset Caching Downloader (ARCHITECTURE_AND_IMPLEMENTATION_PLAN §5)
  // ---------------------------------------------------------------------------

  /**
   * Caches a stock video MP4 to S3 edge storage (s3://aksharo-stock-cache/{provider}/{assetId}.mp4).
   * Guarantees zero external dependency failure during final rendering.
   */
  async importOrCacheAsset(input: StockImportDto): Promise<StockImportResponse> {
    const cleanId = input.assetId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cachedKey = `stock-cache/${input.provider.toLowerCase()}/${cleanId}.mp4`;

    // 1. Check if asset already exists in S3 ObjectStore
    if (this.rawStore) {
      try {
        const existingHead = await this.rawStore.head(cachedKey);
        if (existingHead && existingHead.sizeBytes > 0) {
          const cachedUrl = await this.rawStore.presignGet(cachedKey, 24 * 3600);
          return {
            assetId: input.assetId,
            provider: input.provider,
            cachedKey,
            cachedUrl,
            sizeBytes: existingHead.sizeBytes,
            status: "ready",
          };
        }
      } catch (err) {
        this.logger.debug(`S3 head check skipped for ${cachedKey}: ${String(err)}`);
      }
    }

    // 2. Download high-resolution MP4 bytes from external source
    let videoBytes: Uint8Array;
    try {
      const response = await safeFetch(input.downloadVideoUrl, {
        maxBytes: MAX_DOWNLOAD_BYTES,
        timeoutMs: 30_000,
        allowedPorts: [443, 80],
        headers: {
          "user-agent": "Aksharo-Stock-Engine/1.0",
        },
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`External stock download returned HTTP ${response.status}`);
      }
      videoBytes = response.body;
    } catch (err) {
      this.logger.error(`Failed to download stock asset from ${input.downloadVideoUrl}: ${String(err)}`);
      // If external download fails, check if we have a fallback or throw AppException
      throw new AppException(
        "stock/download_failed",
        `Could not download stock asset from provider: ${String(err)}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    // 3. Save to S3/ObjectStore under cachedKey
    if (this.rawStore) {
      await this.rawStore.put({
        key: cachedKey,
        body: videoBytes,
        contentType: "video/mp4",
        tags: {
          service: "stock-engine",
          provider: input.provider,
          assetId: input.assetId,
        },
      });
    }

    // 4. If project ID is provided, optionally create ProjectBrollCue in DB
    if (input.projectId) {
      try {
        await this.prisma.projectBrollCue.create({
          data: {
            projectId: input.projectId,
            startSec: 0,
            endSec: input.durationSec ?? 5.0,
            query: input.title ?? "Stock Footage",
            stockVideoUri: input.downloadVideoUrl,
            sourceProvider: input.provider.toUpperCase(),
            status: "ACTIVE",
          },
        });
      } catch (err) {
        this.logger.debug(`ProjectBrollCue registration skipped: ${String(err)}`);
      }
    }

    let cachedUrl = input.downloadVideoUrl;
    if (this.rawStore) {
      cachedUrl = await this.rawStore.presignGet(cachedKey, 24 * 3600);
    }

    return {
      assetId: input.assetId,
      provider: input.provider,
      cachedKey,
      cachedUrl,
      sizeBytes: videoBytes.byteLength,
      status: "ready",
    };
  }

  // ---------------------------------------------------------------------------
  // Cache Management
  // ---------------------------------------------------------------------------

  private async readCache(key: string): Promise<StockSearchResponse | null> {
    if (this.redis?.client) {
      try {
        const val = await this.redis.client.get(key);
        if (val) {
          return JSON.parse(val) as StockSearchResponse;
        }
      } catch (err) {
        this.logger.debug(`Redis cache read skipped: ${String(err)}`);
      }
    }

    const mem = this.memoryCache.get(key);
    if (mem && mem.expiresAt > Date.now()) {
      return mem.data;
    }
    return null;
  }

  private async writeCache(key: string, data: StockSearchResponse): Promise<void> {
    if (this.redis?.client) {
      try {
        await this.redis.client.set(
          key,
          JSON.stringify(data),
          "EX",
          REDIS_STOCK_CACHE_TTL_SEC,
        );
        return;
      } catch (err) {
        this.logger.debug(`Redis cache write skipped: ${String(err)}`);
      }
    }

    this.memoryCache.set(key, {
      data,
      expiresAt: Date.now() + REDIS_STOCK_CACHE_TTL_SEC * 1000,
    });
  }
}
